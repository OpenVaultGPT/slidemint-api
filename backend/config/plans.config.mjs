export default {
  PRODUCTS: {
    // 🟢 Subscriptions
    CREATOR:   process.env.CREATOR_PRODUCT_ID,   // SlideMint Creator Plan (£15/mo)
    PRO:       process.env.PRO_PRODUCT_ID,       // SlideMint Pro Plan (£29/mo)
    FREE:      process.env.FREE_PRODUCT_ID,      // SlideMint Free Plan (£0 Lead Magnet)

    // 🟣 One-time credit packs
    STARTER:   process.env.STARTER_PRODUCT_ID,   // SlideMint Starter Pack (£9 one-time)
    BOOST25:   process.env.BOOST25_PRODUCT_ID,   // Booster 25 – Extra 25 Credits (£9)
    BOOST100:  process.env.BOOST100_PRODUCT_ID,  // Booster 100 – Extra 100 Credits (£29)
    BOOST250:  process.env.BOOST250_PRODUCT_ID,  // Booster 250 – Extra 250 Credits (£65)
    BOOST500:  process.env.BOOST500_PRODUCT_ID   // Booster 500 – Extra 500 Credits (£120)
  },

  // 🎞️ Credit usage configuration
  CREDIT_COST: {
    video: 1 // Every video generation costs exactly 1 credit
  },

  // 💳 Subscription plans (monthly)
  SUBSCRIPTIONS: {
    CREATOR:  { monthlyCredits: 15,  rolloverDays: 30, label: "SlideMint Creator Plan" },
    PRO:      { monthlyCredits: 25,  rolloverDays: 30, label: "SlideMint Pro Plan" },
    FREE:     { credits: 5, label: "SlideMint Free Plan", isFree: true }
  },

  // 💥 One-time credit boosters
  BOOSTS: {
    STARTER:  { credits: 10,  expiresDays: 90, label: "SlideMint Starter Pack" },
    BOOST25:  { credits: 25,  expiresDays: 90, label: "Booster 25" },
    BOOST100: { credits: 100, expiresDays: 90, label: "Booster 100" },
    BOOST250: { credits: 250, expiresDays: 90, label: "Booster 250" },
    BOOST500: { credits: 500, expiresDays: 90, label: "Booster 500" }
  }
};
