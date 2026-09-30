import { describe, expect, test } from "bun:test";
import { isDecline, settleFollowUp } from "../src/services/menu.followup.service.ts";
import type { Session } from "../src/lib/session.ts";

/**
 * The "bread or rice with that?" is asked once and a no ends it. These pin the
 * two halves of that: what counts as a no, and that the question closes on the
 * next message whatever it says.
 */

const session = (followUp: Session["followUp"], drinkFollowUp: Session["drinkFollowUp"] = null): Session =>
  ({ id: "s", createdAt: 0, lastSeenAt: 0, turns: [], lastOffer: null, cart: [], followUp, drinkFollowUp }) as Session;

describe("isDecline", () => {
  test.each(["no", "No thanks", "no thank you", "nah", "Nope.", "I'm good", "that's all", "not now", "skip"])(
    "%p is a no",
    (text) => expect(isDecline(text)).toBe(true),
  );

  // A no to the upsell is a whole message. Anything longer is a request, and
  // must reach the normal routes rather than be swallowed as "No problem."
  test.each(["no onions in the curry please", "add the kulcha", "yes", "no, remove the curry", "not spicy"])(
    "%p is not",
    (text) => expect(isDecline(text)).toBe(false),
  );
});

describe("settleFollowUp", () => {
  test("a no is taken at once and the question closes", () => {
    const s = session({ askedAt: 1, pending: true });
    expect(settleFollowUp(s, "No thanks")).toBe("side");
    expect(s.followUp?.pending).toBe(false);
  });

  test("moving on without answering also closes it", () => {
    const s = session({ askedAt: 1, pending: true });
    expect(settleFollowUp(s, "what desserts do you have?")).toBeNull();
    expect(s.followUp?.pending).toBe(false);
  });

  test("a no with nothing asked is not intercepted", () => {
    expect(settleFollowUp(session(null), "no")).toBeNull();
    expect(settleFollowUp(session({ askedAt: 1, pending: false }), "no")).toBeNull();
  });

  test("the question stays spent, so it is never asked twice", () => {
    const s = session({ askedAt: 1, pending: true });
    settleFollowUp(s, "no");
    expect(s.followUp).not.toBeNull();
  });
});

describe("the drink question", () => {
  test("a no to the drink is told apart from a no to the bread", () => {
    const s = session({ askedAt: 1, pending: false }, { askedAt: 2, pending: true });
    expect(settleFollowUp(s, "no thanks")).toBe("drink");
    expect(s.drinkFollowUp?.pending).toBe(false);
  });

  test("it stays spent once answered", () => {
    const s = session(null, { askedAt: 2, pending: true });
    settleFollowUp(s, "what desserts do you have?");
    expect(s.drinkFollowUp).not.toBeNull();
    expect(settleFollowUp(s, "no")).toBeNull();
  });
});
