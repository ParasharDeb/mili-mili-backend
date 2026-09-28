import { beforeEach, describe, expect, test } from "bun:test";
import * as copy from "../src/domain/concierge.copy.ts";
import {
  detectAnger,
  detectHardStop,
  detectTopic,
  parseReservation,
  reviewedDish,
  reviewSentiment,
} from "../src/domain/concierge.detect.ts";
import { getSession, type Session } from "../src/lib/session.ts";
import { handleConcierge, type ConciergeStore } from "../src/services/concierge.service.ts";
import { feedbackTier, submitFeedback } from "../src/services/feedback.service.ts";
import { routeHeuristic, type Route } from "../src/services/menu.route.service.ts";

/**
 * The concierge is the part of the chat that talks to the floor. The rule these
 * encode above all: a hard stop is never answered with anything but the one
 * line, and after it the assistant says nothing.
 */

type Logged = { type: string; message: string; details?: Record<string, unknown> };
type Reviewed = { message: string; sentiment: string; dish: string | null };

function fakeStore(): ConciergeStore & { logged: Logged[]; feedback: unknown[]; reviews: Reviewed[] } {
  const logged: Logged[] = [];
  const feedback: unknown[] = [];
  const reviews: Reviewed[] = [];
  return {
    logged,
    feedback,
    reviews,
    async logReview(row) {
      reviews.push({ message: row.message, sentiment: row.sentiment, dish: row.dish });
    },
    async logRequest(row) {
      logged.push({ type: row.type, message: row.message, details: row.details });
    },
    async touchVisit() {},
    async saveFeedback(row) {
      feedback.push(row);
    },
    async claimReviewAsk() {
      return true;
    },
  };
}

let session: Session;
let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  session = getSession();
  store = fakeStore();
});

const route = (message: string): Route => routeHeuristic(message, session);
const turn = (message: string) => handleConcierge(message, session, route(message), null, store);
const answerOf = (o: Awaited<ReturnType<typeof turn>>) => (o && "reply" in o ? o.reply.answer : null);

describe("hard stops", () => {
  test.each([
    ["I think I have food poisoning", "illness"],
    ["there's a hair in my curry", "foreign_object"],
    ["found a cockroach near the plate", "foreign_object"],
    ["my throat is swelling up", "allergic_reaction"],
    ["I cut my finger on the glass", "injury"],
    ["the waiter was really rude to my wife", "staff_conduct"],
    ["you've overcharged us", "bill_dispute"],
    ["I'm calling the police", "legal_or_media"],
    ["I'm posting this on instagram", "legal_or_media"],
  ])("%p -> %p", (message, category) => {
    expect(detectHardStop(message)).toBe(category as never);
  });

  test.each([
    "does the korma contain nuts?",
    "I'm allergic to peanuts, what's safe?",
    "a glass of red wine please",
    "is the biryani spicy",
    "are there extra charges for a birthday cake?",
  ])("not a hard stop: %p", (message) => {
    expect(detectHardStop(message)).toBeNull();
  });

  test("says exactly one line, logs it, and mutes the session", async () => {
    const out = await turn("there's glass in my food");
    expect(out && "reply" in out && out.reply).toEqual({
      answer: copy.HANDOFF,
      chips: [],
      action: "handoff",
      muted: true,
    });
    expect(session.mutedAt).toBeTruthy();
    expect(store.logged).toEqual([
      { type: "hard_stop", message: "there's glass in my food", details: { category: "foreign_object" } },
    ]);
  });

  test("anger after one apology becomes a hard stop", async () => {
    expect(detectAnger("this is ridiculous")).toBe(true);
    expect(answerOf(await turn("this is ridiculous"))).toBe(copy.ANGER_APOLOGY);
    expect(session.mutedAt ?? null).toBeNull();

    const second = await turn("honestly the worst service");
    expect(answerOf(second)).toBe(copy.HANDOFF);
    expect(store.logged.at(-1)?.details).toEqual({ category: "persistent_anger" });
  });
});

describe("topics", () => {
  test.each([
    ["the music is too loud", "issue"],
    ["our table is wobbly", "issue"],
    ["still waiting for our food", "issue"],
    ["can I speak to the manager", "call_manager"],
    ["can you call the waiter", "call_captain"],
    ["I'd like to book a table for saturday", "reservation"],
    ["can you play some Arijit Singh", "music_request"],
    ["it's my birthday today", "occasion"],
    ["we're waiting for our friends", "waiting_for_friends"],
    ["bye, thanks for tonight", "farewell"],
    ["I want to give feedback", "feedback"],
    ["something spicy with whisky", "none"],
    ["we have a reservation under Sen", "none"],
    ["no complaints, lovely food", "none"],
    ["what should the four of us order", "none"],
  ])("%p -> %p", (message, topic) => {
    expect(detectTopic(message)).toBe(topic as never);
  });

  test("an issue is logged and acknowledged quietly", async () => {
    expect(answerOf(await turn("the AC is too cold"))).toBe(copy.ISSUE_ACK);
    expect(store.logged.map((l) => l.type)).toEqual(["issue"]);
  });

  test("music requests promise nothing", async () => {
    expect(answerOf(await turn("could you play something by Coldplay"))).toBe(copy.MUSIC_REQUEST);
    expect(store.logged.map((l) => l.type)).toEqual(["music"]);
  });

  test("a birthday gets one line, once", async () => {
    expect(answerOf(await turn("it's my birthday today"))).toBe(copy.OCCASION.birthday(null));
    expect(await turn("it's my birthday today")).toBeNull();
  });

  test("a birthday alongside a menu request is a preface, not a reply", async () => {
    const message = "it's our anniversary, suggest a dessert";
    const r = { ...route(message), intent: "advisory" as const, conciergeTopic: "occasion" as const };
    const out = await handleConcierge(message, session, r, null, store);
    expect(out).toEqual({ preface: copy.OCCASION.anniversary(null) });
  });

  test("the closing line is said once", async () => {
    expect(answerOf(await turn("goodnight"))).toBe(copy.CLOSING(null));
    expect(answerOf(await turn("goodnight"))).toBe(copy.FAREWELL_AGAIN);
  });
});

describe("reservations", () => {
  test("parses day, time and party size as text", () => {
    expect(parseReservation("book a table for 4 on saturday at 9pm")).toEqual({
      dateText: "saturday",
      timeText: "9pm",
      partySize: 4,
    });
    expect(parseReservation("6", "partySize").partySize).toBe(6);
    expect(parseReservation("8", "time").timeText).toBe("8");
  });

  test("asks one thing at a time and never confirms", async () => {
    expect(answerOf(await turn("can I book a table for saturday"))).toBe(copy.RESERVATION_ASK.time);
    expect(answerOf(await turn("around 9pm"))).toBe(copy.RESERVATION_ASK.partySize);
    expect(store.logged).toEqual([]);

    expect(answerOf(await turn("5"))).toBe(copy.RESERVATION_TAKEN);
    expect(store.logged).toHaveLength(1);
    expect(store.logged[0]!.details).toMatchObject({ dateText: "saturday", timeText: "9pm", partySize: 5 });
    expect(session.pendingReservation).toBeNull();
  });

  test("changing the subject drops the half-made booking", async () => {
    await turn("I want to make a reservation");
    expect(await turn("is the biryani spicy")).toBeNull();
    expect(session.pendingReservation).toBeNull();
  });
});

describe("feedback", () => {
  const all = (n: number) => ({ overall: n, food: n, service: n, ambience: n, cleanliness: n });

  test("the ladder", () => {
    expect(feedbackTier(all(5))).toEqual({ tier: "five", escalate: false });
    expect(feedbackTier(all(4))).toEqual({ tier: "four", escalate: false });
    expect(feedbackTier(all(3))).toEqual({ tier: "three", escalate: false });
    expect(feedbackTier(all(2))).toEqual({ tier: "low", escalate: true });
    expect(feedbackTier(all(1))).toEqual({ tier: "low", escalate: true });
  });

  test("any category at 2 or below escalates, whatever the overall", () => {
    expect(feedbackTier({ ...all(5), cleanliness: 2 })).toEqual({ tier: "low", escalate: true });
  });

  test("'Not now' is honoured silently", async () => {
    const out = await turn("Not now");
    expect(answerOf(out)).toBe("");
    expect(session.feedbackDeclined).toBe(true);
  });

  test("'Everything was lovely' saves a quick five and closes the evening", async () => {
    const out = await turn("Everything was lovely");
    expect(answerOf(out)).toContain(copy.FEEDBACK_REPLY.five);
    expect(answerOf(out)).toContain(copy.CLOSING(null));
    expect(store.feedback).toHaveLength(1);
    expect(answerOf(await turn("Everything was lovely"))).toBe(copy.FEEDBACK_ALREADY);
  });

  test("a low rating offers the manager, and yes logs a request", async () => {
    const r = await submitFeedback(session, null, { ...all(2), comment: "cold food" }, { store });
    expect(r.answer).toBe(copy.FEEDBACK_REPLY.low);
    expect(r.chips).toEqual([...copy.MANAGER_OFFER_BUTTONS]);

    expect(answerOf(await turn("Yes, please"))).toBe(copy.MANAGER_YES);
    expect(store.logged.map((l) => l.type)).toEqual(["call_manager"]);
  });

  test("a low rating declined still stands", async () => {
    await submitFeedback(session, null, { ...all(1), comment: undefined }, { store });
    expect(answerOf(await turn("No, thank you"))).toBe(copy.MANAGER_NO);
    expect((store.feedback[0] as { escalate: boolean }).escalate).toBe(true);
  });

  test("a second submission is refused", async () => {
    await submitFeedback(session, null, { ...all(4), comment: undefined }, { store });
    expect(submitFeedback(session, null, { ...all(4), comment: undefined }, { store })).rejects.toThrow();
  });
});

describe("the name", () => {
  test("is said once per visit", async () => {
    const guest = { userId: "u1", name: "Asha", lastVisitAt: null };
    const first = await handleConcierge("goodnight", session, route("goodnight"), guest, store);
    expect(answerOf(first)).toBe(copy.CLOSING("Asha"));

    const again = await handleConcierge("it's my birthday", session, route("it's my birthday"), guest, store);
    expect(answerOf(again)).toBe(copy.OCCASION.birthday(null));
  });

  test("a long gap is mentioned once", async () => {
    const guest = { userId: "u1", name: null, lastVisitAt: new Date(Date.now() - 200 * 86_400_000) };
    const out = await handleConcierge("hello", session, route("hello"), guest, store);
    expect(answerOf(out)).toBe(copy.LONG_GAP);
    expect(await handleConcierge("hello", session, route("hello"), guest, store)).toBeNull();
  });
});

describe("reviews said in passing", () => {
  test.each([
    ["the pasta was too bland", "negative", "pasta"],
    ["The butter chicken was amazing.", "positive", "butter chicken"],
    ["loved the paneer tikka", "positive", "paneer tikka"],
    ["the naan was a bit dry", "negative", "naan"],
    ["the dal wasn't great", "negative", "dal"],
    ["the cocktail was not that good", "negative", "cocktail"],
    ["great naan but the dal was too salty", "mixed", null],
    ["the food was cold", "negative", null],
    ["service was slow", "negative", null],
  ])("%p is a %s review", (message, sentiment, dish) => {
    expect(detectTopic(message)).toBe("review");
    expect(reviewSentiment(message)).toBe(sentiment as never);
    if (dish) expect(reviewedDish(message)?.toLowerCase()).toBe(dish);
  });

  test.each([
    "is the pasta bland?",
    "is the biryani very hot",
    "something not too spicy",
    "suggest a dish that is spicy",
    "I want something light",
    "what is in the butter naan",
    "which one is the best",
  ])("%p is not a review", (message) => {
    expect(detectTopic(message)).not.toBe("review");
  });

  test("a present-tense problem is still an issue for the floor, not a review", () => {
    expect(detectTopic("the food is cold")).toBe("issue");
  });

  test("the pasta was too bland is stored and thanked for", async () => {
    const out = await turn("the pasta was too bland");
    expect(store.reviews).toEqual([{ message: "the pasta was too bland", sentiment: "negative", dish: "pasta" }]);
    expect(answerOf(out)).toBe(copy.REVIEW_THANKS.negative);
    expect(out && "reply" in out && out.reply.action).toBe("review_logged");
    expect(out && "reply" in out && out.reply.chips).toEqual([...copy.REVIEW_NEGATIVE_CHIPS]);
  });

  test("praise gets no captain offer", async () => {
    const out = await turn("loved the biryani");
    expect(store.reviews[0]?.sentiment).toBe("positive");
    expect(out && "reply" in out && out.reply.chips).toEqual([]);
  });

  test("a review riding with a request is stored, and the request still gets dishes", async () => {
    const message = "the pasta was bland, something spicier";
    const r: Route = { ...route(message), conciergeTopic: "review", intent: "structured_query", reviewSentiment: "negative" };
    const out = await handleConcierge(message, session, r, null, store);
    expect(store.reviews).toHaveLength(1);
    expect(out).toEqual({ preface: copy.REVIEW_NOTED });
  });

  test("a failed write still thanks the guest", async () => {
    store.logReview = async () => {
      throw new Error("db down");
    };
    expect(answerOf(await turn("the pasta was too bland"))).toBe(copy.REVIEW_THANKS.negative);
  });
});

describe("disliking a dish on the order", () => {
  const onOrder = (name: string, itemId: string, addedAt: number) =>
    session.cart.push({ itemId, name, qty: 1, unitPrice: 100, addedAt });
  const reply = (o: Awaited<ReturnType<typeof turn>>) => (o && "reply" in o ? o.reply : null);

  beforeEach(() => {
    onOrder("Butter Naan", "naan", 1);
    onOrder("Grilled Chicken Cheese Pasta", "pasta", 2);
  });

  test.each(["i dont like it", "I don't like it", "I don't like the pasta", "the pasta was too bland"])(
    "%p asks before removing, and removes nothing yet",
    async (message) => {
      const out = reply(await turn(message));
      expect(out?.answer).toBe(copy.REMOVE_CONFIRM("Grilled Chicken Cheese Pasta"));
      expect(out?.chips).toEqual([...copy.REMOVE_BUTTONS]);
      expect(out?.removeItemId).toBeUndefined();
      expect(session.pendingRemoval?.itemId).toBe("pasta");
      expect(store.reviews).toEqual([]);
    },
  );

  test("'it' means the dish added last; a named dish means that one", async () => {
    await turn("I don't like the naan");
    expect(session.pendingRemoval?.itemId).toBe("naan");
  });

  test.each(["Yes, remove it", "yes", "please remove it"])("%p removes it and files no review", async (answer) => {
    await turn("i dont like it");
    const out = reply(await turn(answer));
    expect(out?.removeItemId).toBe("pasta");
    expect(out?.answer).toBe(copy.REMOVE_DONE("Grilled Chicken Cheese Pasta"));
    expect(store.reviews).toEqual([]);
    expect(session.pendingRemoval).toBeNull();
  });

  test.each(["No, keep it", "no", "no, don't remove it", "leave it"])(
    "%p keeps it and files the dislike as a review",
    async (answer) => {
      await turn("i dont like it");
      const out = reply(await turn(answer));
      expect(out?.removeItemId).toBeUndefined();
      expect(out?.answer).toBe(copy.REMOVE_KEPT);
      expect(store.reviews).toEqual([
        { message: "i dont like it", sentiment: "negative", dish: "Grilled Chicken Cheese Pasta" },
      ]);
    },
  );

  test("changing the subject keeps the dish, files the review, and answers the new message", async () => {
    await turn("i dont like it");
    const out = await turn("can you play some jazz");
    expect(reply(out)?.action).toBe("music_requested");
    expect(store.reviews).toHaveLength(1);
    expect(session.pendingRemoval).toBeNull();
  });

  test("a dislike of something not on the order is just a review", async () => {
    const out = reply(await turn("the biryani was too salty"));
    expect(out?.action).toBe("review_logged");
    expect(session.pendingRemoval).toBeFalsy();
  });

  test("with an empty order, 'I don't like it' is just a review", async () => {
    session.cart = [];
    const out = reply(await turn("i dont like it"));
    expect(out?.action).toBe("review_logged");
  });

  test("a preference is not a complaint", async () => {
    expect(reply(await turn("I don't like spicy food"))?.action).not.toBe("remove_confirm");
  });
});
