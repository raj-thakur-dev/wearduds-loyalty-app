// Defaults agreed with Wearduds in the points & redemption meeting.
// Everything here is editable from the admin; these only seed a new shop.

// 1 coin = ₹1. Purchase earn rate and redemption rules live on ProgramSettings
// (pointsPerCurrency = 0.03 is 3% back). Bonus amounts below are in coins (₹).

export const DEFAULT_EARN_RULES = {
  purchase: { enabled: true },
  signup: { enabled: true, points: 10 },
  birthdaySetup: { enabled: true, points: 5 },
  birthday: { enabled: true, points: 20, daysBefore: 3 },
  review: { enabled: true, points: 5, minWords: 20, requireVerifiedBuyer: true },
  photoReview: { enabled: true, points: 10 },
  referral: {
    enabled: true,
    referrerPoints: 100,
    friendPoints: 100,
    monthlyCap: 10,
  },
  // Every Nth order (after its return window) inside `windowDays` earns a bonus.
  streak: { enabled: true, points: 50, orders: 3, windowDays: 90 },
  instagram: { enabled: false, points: 5, handle: "wearduds" },
  newsletter: { enabled: false, points: 5 },
};

export const DEFAULT_WIDGET = {
  accent: "#FF6B1A",
  launcherLabel: "Rewards",
  launcherPosition: "right",
  showLauncher: true,
  guestHeadline: "Get paid to get dressed.",
  guestBody: "Join free and get 3% back in Club Coins on every order. 1 coin = ₹1.",
  clubPageUrl: "/pages/wearduds-club",
  faq: [
    {
      q: "What are Club Coins worth?",
      a: "1 coin = ₹1. You get 3% back in coins on every order, more at Gold and Platinum.",
    },
    {
      q: "When do I get coins for an order?",
      a: "They show as pending straight away and unlock 7 days after your order is delivered, once the return window has passed.",
    },
    {
      q: "How do I use my coins?",
      a: "In your cart, tap Use coins. They're added to your account as store credit, which you apply in one tap at checkout. Coins work on orders of ₹1,499 or more and can pay for up to 20% of an order.",
    },
    {
      q: "Do coins expire?",
      a: "Coins expire 3 months after they unlock. We remind you 30 days and 7 days before.",
    },
    {
      q: "How do tiers work?",
      a: "Your tier depends on what you spend in the last 12 months: Gold from ₹5,000, Platinum from ₹15,000. Orders count once their return window has passed.",
    },
  ],
};

export const DEFAULT_TIERS = [
  {
    name: "Silver",
    threshold: 0,
    multiplier: 1,
    color: "#9CA3AF",
    perks: ["3% back in coins", "Birthday coins", "Order-streak bonus"],
  },
  {
    name: "Gold",
    threshold: 5000,
    multiplier: 1.25,
    color: "#E0A100",
    perks: ["1.25x coins on every order", "Free shipping, no minimum", "15-day returns", "Early access to drops"],
  },
  {
    name: "Platinum",
    threshold: 15000,
    multiplier: 1.5,
    color: "#111111",
    perks: ["1.5x coins on every order", "Free express shipping", "30-day returns", "48h early access + invite-only drops"],
  },
];

// Coins are spent as store credit from the cart, so no ₹-off code rewards by default.
// Staff can still add code rewards (e.g. free shipping) in Rewards & tiers.
export const DEFAULT_REWARDS = [];

export const EARN_RULE_META = {
  purchase: { title: "Shop", ledgerType: "PURCHASE" },
  signup: { title: "Create an account", ledgerType: "SIGNUP" },
  birthdaySetup: { title: "Add your birthday", ledgerType: "BIRTHDAY_SETUP" },
  birthday: { title: "Birthday gift", ledgerType: "BIRTHDAY" },
  review: { title: "Write a review", ledgerType: "REVIEW" },
  photoReview: { title: "Review with a photo", ledgerType: "REVIEW" },
  referral: { title: "Refer a friend", ledgerType: "REFERRAL_REFERRER" },
  streak: { title: "Order streak", ledgerType: "STREAK" },
  instagram: { title: "Follow on Instagram", ledgerType: "INSTAGRAM" },
  newsletter: { title: "Join the newsletter", ledgerType: "NEWSLETTER" },
};

export const LEDGER_LABELS = {
  PURCHASE: "Order",
  SIGNUP: "Welcome bonus",
  BIRTHDAY: "Birthday gift",
  BIRTHDAY_SETUP: "Added birthday",
  REVIEW: "Review",
  REFERRAL_REFERRER: "Referral",
  REFERRAL_FRIEND: "Referral welcome",
  INSTAGRAM: "Instagram follow",
  NEWSLETTER: "Newsletter",
  RETRO: "Welcome-back coins",
  ADJUSTMENT: "Adjustment",
  REDEMPTION: "Used as store credit",
  REDEMPTION_RESTORED: "Coins returned",
  REFUND_REVERSAL: "Refund",
  EXPIRY: "Expired",
  STREAK: "Order streak bonus",
};
