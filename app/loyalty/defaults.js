// Defaults agreed with Wearduds in the points & redemption meeting.
// Everything here is editable from the admin; these only seed a new shop.

export const DEFAULT_EARN_RULES = {
  purchase: { enabled: true },
  signup: { enabled: true, points: 100 },
  birthdaySetup: { enabled: true, points: 50 },
  birthday: { enabled: true, points: 200, daysBefore: 3 },
  review: { enabled: true, points: 50, minWords: 20, requireVerifiedBuyer: true },
  photoReview: { enabled: true, points: 100 },
  referral: {
    enabled: true,
    referrerPoints: 300,
    friendPoints: 100,
    monthlyCap: 10,
  },
  instagram: { enabled: false, points: 50, handle: "wearduds" },
  newsletter: { enabled: false, points: 25 },
};

export const DEFAULT_WIDGET = {
  accent: "#FF6B1A",
  launcherLabel: "Rewards",
  launcherPosition: "right",
  showLauncher: true,
  guestHeadline: "Get paid to get dressed.",
  guestBody: "Join free, grab 100 points, and turn every order into money off the next one.",
  clubPageUrl: "/pages/wearduds-club",
  faq: [
    {
      q: "When do I get points for an order?",
      a: "They show as pending straight away and unlock 7 days after your order is delivered, once the return window has passed.",
    },
    {
      q: "What are points worth?",
      a: "100 points = ₹10 off. You can use points on up to 20% of an order.",
    },
    {
      q: "Do points expire?",
      a: "Points expire 12 months after you earn them. We email you 30 days before.",
    },
    {
      q: "How do tiers work?",
      a: "Tiers are based on all the points you have ever earned, so spending points never drops your tier.",
    },
  ],
};

export const DEFAULT_TIERS = [
  {
    name: "Silver",
    threshold: 0,
    multiplier: 1,
    color: "#9CA3AF",
    perks: ["Free shipping on ₹999+", "7-day returns", "Birthday gift"],
  },
  {
    name: "Gold",
    threshold: 5000,
    multiplier: 1.25,
    color: "#E0A100",
    perks: [
      "1.25x points on every order",
      "Free shipping, no minimum",
      "14-day returns",
      "24h early access to drops",
    ],
  },
  {
    name: "Platinum",
    threshold: 15000,
    multiplier: 1.5,
    color: "#111111",
    perks: [
      "1.5x points on every order",
      "Free express shipping",
      "30-day returns",
      "48h early access + invite-only drops",
    ],
  },
];

export const DEFAULT_REWARDS = [
  { title: "₹50 off", type: "FIXED_AMOUNT", pointsCost: 500, value: 50, minSubtotal: 500 },
  { title: "₹100 off", type: "FIXED_AMOUNT", pointsCost: 1000, value: 100, minSubtotal: 800 },
  { title: "₹250 off", type: "FIXED_AMOUNT", pointsCost: 2500, value: 250, minSubtotal: 1500 },
  { title: "₹500 off", type: "FIXED_AMOUNT", pointsCost: 5000, value: 500, minSubtotal: 3000 },
];

export const EARN_RULE_META = {
  purchase: { title: "Shop", ledgerType: "PURCHASE" },
  signup: { title: "Create an account", ledgerType: "SIGNUP" },
  birthdaySetup: { title: "Add your birthday", ledgerType: "BIRTHDAY_SETUP" },
  birthday: { title: "Birthday gift", ledgerType: "BIRTHDAY" },
  review: { title: "Write a review", ledgerType: "REVIEW" },
  photoReview: { title: "Review with a photo", ledgerType: "REVIEW" },
  referral: { title: "Refer a friend", ledgerType: "REFERRAL_REFERRER" },
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
  RETRO: "Welcome-back points",
  ADJUSTMENT: "Adjustment",
  REDEMPTION: "Redeemed",
  REDEMPTION_RESTORED: "Points returned",
  REFUND_REVERSAL: "Refund",
  EXPIRY: "Expired",
};
