/**
 * Every line the concierge says that is not about a dish.
 *
 * Kept in one file so the voice is reviewed in one place: a maitre d' who
 * happens to be typing. Short, calm, no exclamation marks, no emoji, offer
 * rather than push, and never a promised time or a comped item -- that is the
 * manager's authority, not ours.
 */

/** The only thing said on a hard stop. Nothing before it, nothing after it. */
export const HANDOFF = "I'm getting a manager to you right now.";

export const ISSUE_ACK =
  "Thank you for telling me. I've passed it to the floor, and it will be sorted quietly.";

export const CALL_MANAGER = "Of course. I've asked our manager to stop by your table.";
export const CALL_CAPTAIN = "Of course. I've asked your captain to come over.";

export const MUSIC_REQUEST = "I'll pass it to the floor -- no promises, but they usually try.";

export const RESERVATION_TAKEN = "Let me check with the desk and come straight back to you.";
export const RESERVATION_ASK = {
  date: "Happy to ask the desk. Which day would you like the table?",
  time: "And around what time?",
  partySize: "How many of you will there be?",
} as const;

export const FEEDBACK_ASK = (name: string | null) =>
  `Thank you for dining with us this evening${name ? `, ${name}` : ""}. If anything fell short -- ` +
  "or anything stood out -- I'd like to hear it. It genuinely shapes how we run the floor.";
export const FEEDBACK_BUTTONS = ["Share feedback", "Everything was lovely", "Not now"] as const;
export const FEEDBACK_ALREADY = "You've already shared your thoughts this evening. Thank you again.";

export const FEEDBACK_REPLY = {
  five: "Thank you. That is lovely to hear, and I'll make sure the team does too.",
  reviewLink: (url: string) => `If you have a moment, a few words on Google would mean a great deal: ${url}`,
  four: "Glad it was good. What would have made it a five?",
  three:
    "Thank you for being straight with me -- that's more useful than a polite five. " +
    "If you can tell me what specifically let you down, I'll make sure it reaches the right person tonight.",
  low:
    "I'm sorry. That isn't the evening we wanted to give you. " +
    "Would you like our manager to come to your table? They can put it right now rather than after you've left.",
} as const;
export const MANAGER_OFFER_BUTTONS = ["Yes, please", "No, thank you"] as const;
export const MANAGER_YES = "Our manager is on the way to your table.";
export const MANAGER_NO =
  "Understood. I've passed it on regardless, and someone will look at it tonight. Thank you for telling us.";

export const OCCASION = {
  birthday: (name: string | null) =>
    `Happy birthday${name ? `, ${name}` : ""}. We're glad you chose to spend it with us.`,
  anniversary: (name: string | null) =>
    `Happy anniversary${name ? `, ${name}` : ""}. We're glad you chose to celebrate it with us.`,
  other: (name: string | null) =>
    `What a lovely thing to celebrate${name ? `, ${name}` : ""}. We're glad you're marking it with us.`,
} as const;

export const WAITING_FOR_FRIENDS = "Would you like something to drink while you wait?";
export const WAITING_CHIPS = ["Something light to drink", "A mocktail", "Not yet, thanks"] as const;

export const LONG_GAP = "It's been a while -- we've changed the menu since. Want the highlights?";

export const CLOSING = (name: string | null) =>
  `Thank you for this evening${name ? `, ${name}` : ""}. We'd love to have you back. ` +
  "This chat stays here -- message any time you'd like a table.";

/** The one apology. Anger after this is a hard stop -- never apologise twice. */
export const ANGER_APOLOGY =
  "I'm sorry -- that isn't how this evening should feel. I've passed it to the floor and it will be put right quietly.";

export const FAREWELL_AGAIN = "Thank you again. Good night.";
