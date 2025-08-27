export default {
  PRODUCTS: {
    PRO:       process.env.PRO_PRODUCT_ID,
    BUSINESS:  process.env.BUSINESS_PRODUCT_ID,
    BOOST100:  process.env.BOOST100_PRODUCT_ID,
    BOOST250:  process.env.BOOST250_PRODUCT_ID,
    BOOST500:  process.env.BOOST500_PRODUCT_ID,
    AFFILIATE: process.env.AFFILIATE_PRODUCT_ID,
  },

  CREDIT_COST: {
    video1080p: 1,   // 1 credit = 1 HD slideshow + Social Pack
    video4k: 2,      // or >60s duration
    socialOnly: 0.10 // for Affiliate Assistant overage (optional)
  },

  SUBSCRIPTIONS: {
    PRO:       { monthlyCredits: 25,  rolloverDays: 30, overageGBP: 0.75, csvRowsMax: 50,  concurrency: 3 },
    BUSINESS:  { monthlyCredits: 100, rolloverDays: 30, overageGBP: 0.49, csvRowsMax: 200, concurrency: 5, priority: true },
    AFFILIATE: { socialIncluded: 300 }
  },

  BOOSTS: {
    BOOST100: { credits: 100, expiresDays: 90, csvRowsMax: 200,  concurrency: 3 },
    BOOST250: { credits: 250, expiresDays: 90, csvRowsMax: 500,  concurrency: 4 },
    BOOST500: { credits: 500, expiresDays: 90, csvRowsMax: 1000, concurrency: 5 }
  }
};
