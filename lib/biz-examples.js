// Reel Business Studio example reels: 4 sample photos per industry (AI-made, clearly labelled as samples on the page)
// and the AI motion clip made from each. The server fetches each file once from the AI service's storage and serves it
// from this site, so the studio can draw the clips into a video (browsers won't draw another site's video).
// The sample businesses are made up; their phone numbers are in the 555-01xx range that's reserved for fiction.
export const BIZ_EXAMPLES = {
  "restaurant": {
    "biz": {
      "agent": "Brick & Basil Pizza",
      "headline": "Wood-fired, every night",
      "cta": "Order tonight",
      "brokerage": "Open daily 11 AM to 10 PM",
      "phone": "(612) 555-0142"
    },
    "shots": [
      {
        "caption": "Straight from the oven",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/K2e-zChLLvCRSnmj_iCan_9dd3c188afd94ec3a9d5a6b9e5e75b7b.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3bd/jX-dSP_da-jOKj_YQ5Pvm_bY9bHy8V.mp4"
      },
      {
        "caption": "The cheese pull",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/2rAWqVUrVpKUX_zyHYx98_a1caefa5bf6a4e9aacd12e7f37c2d8c8.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b8/OCy33aYBIAGzoYoejyYKP_EgUhnENM.mp4"
      },
      {
        "caption": "Fresh basil on every pie",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/vVsD-GOOnMzrTezo-u3H1_710dd54651f94352bfb7fe77ac180420.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b1/zahEgfAFi5-Al5pe0Ne87_Eol27kcK.mp4"
      },
      {
        "caption": "Bring the whole crew",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/iVco_ThmuO54vqKu4AZCR_967fa5b4543a4dc2a930664181f3e0c4.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b3/bGq5W6a-rwYYYlYjdDAQY_VGqCGBI8.mp4"
      }
    ]
  },
  "bakery": {
    "biz": {
      "agent": "Golden Crust Bakery",
      "headline": "Baked fresh every morning",
      "cta": "Stop in today",
      "brokerage": "Open 6 AM to 2 PM",
      "phone": "(612) 555-0117"
    },
    "shots": [
      {
        "caption": "Made by hand",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/fx0R_ywZ1jm0-KLZv7_Gl_89a337387c9345ebb76daeb036f6f8fe.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3ae/xfsyhlea22JglM67jaI30_lsMDfqag.mp4"
      },
      {
        "caption": "Fresh out of the oven",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/VKXUG-ksndBJy02rUUIai_4263d6eccdc242d1a6ef60d89980a80c.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3bd/syxEA5fkISM59BoVTder2_output.mp4"
      },
      {
        "caption": "Layer after layer",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/a42K_R6ZqVbspdRQSwdnl_d44a324626c34f5286a1889639267400.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/JFuHZghRUiBO1Syu5Glyl_7VFgqg3L.mp4"
      },
      {
        "caption": "Something for everyone",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/6xXYSnv5GviH_bvQfuom4_b9738400eb5f4e6493e01bf1152f7336.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/2aZtUBzZLrLfThbXFoWyO_hh05DPNk.mp4"
      }
    ]
  },
  "barber": {
    "biz": {
      "agent": "Sharp Line Barbers",
      "headline": "The cut that gets noticed",
      "cta": "Book your chair",
      "brokerage": "Walk-ins welcome",
      "phone": "(612) 555-0168"
    },
    "shots": [
      {
        "caption": "Walk in like this",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/UuNHrbumRBZeye9lu7krO_98451b1cbafd4ac785fabef821327b04.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b2/4He8AWrOvyrrqyA11qvPp_kXIA3dst.mp4"
      },
      {
        "caption": "Clean skin fade",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/HtasH3k_N1m-_kceaWj6a_a8b8e173843d48c2a31e91249a748d68.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b0/PNK1yF5M2xPu_WDsCEtyX_PjE7NJBu.mp4"
      },
      {
        "caption": "Razor-sharp lines",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/krSYPdXYXRD96uzS7GcZF_4101ad733ee34c9f828ae94ba9594a1b.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3bb/e_1z9bNtKdK7x32Zf_WwT_ZmEmcJvI.mp4"
      },
      {
        "caption": "Walk out like this",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/d-3yfbxHcRM4olYBKI-Rk_daebb8712b3b4c3a83217ab5c603065c.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/AAB2_PyhdozNl0OqgGUEz_XKcVErV8.mp4"
      }
    ]
  },
  "salon": {
    "biz": {
      "agent": "Luxe Hair Studio",
      "headline": "Hair you can't stop touching",
      "cta": "Book your appointment",
      "brokerage": "Tuesday to Saturday",
      "phone": "(612) 555-0133"
    },
    "shots": [
      {
        "caption": "The perfect blowout",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/YmJHhmYAJKXiiFWeZjv7P_7415fcceac1343028dc31fe8a19955a2.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/HJZ_2VY2DNW2eFS9riN2s_O6jIv3CV.mp4"
      },
      {
        "caption": "Hand-painted balayage",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/EZyKstBzzkDwUi1tMVrDQ_a323281c35454372aac38400121c68a7.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/R46fZ6fYCkgmkiS0e0xEx_iuRTunTV.mp4"
      },
      {
        "caption": "Soft, glossy waves",
        "image": "https://v3b.fal.media/files/b/0ab3c36d/D-lLLhj2G875ihTkoQLoa_9211d03fcb394a5fb786f2e8c3c15704.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3ad/Gw5Ghn9y1PJG1bdhMJwn3_4YYMddt0.mp4"
      },
      {
        "caption": "Your mirror moment",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/awwK5Qm3BkVo7BldBbSdY_c3836fef536e46d6bcb8e5c8b3a27737.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/8XVHiB6M4uVxRAtXKVrKU_GU3ilrt8.mp4"
      }
    ]
  },
  "nails": {
    "biz": {
      "agent": "Polished Nail Bar",
      "headline": "Nails that get compliments",
      "cta": "Book your set",
      "brokerage": "Open 7 days",
      "phone": "(612) 555-0181"
    },
    "shots": [
      {
        "caption": "Flawless polish",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/KXlb9IVXvGb3LdNUzgJzs_8e2692eed7d847ceb36b424bcd434663.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b9/pSUVqOPvgOadHzzrdCtpi_EEOrsQXL.mp4"
      },
      {
        "caption": "Custom nail art",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/fX_Si4dWuBamUozalivGL_d9fc3ce1bdd8443dbc7357a2126e1664.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c0/VFTKcmDot6nKN3GTdS1W0_yGBGpoGs.mp4"
      },
      {
        "caption": "Cured to last",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/NilAtAmg0gVcrpavjn_S8_5cde86029e5c44178e792b9a8cb4c5da.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3be/1VFcX40LuzQvTtLDMX4i5_4VlIVWGw.mp4"
      },
      {
        "caption": "Made to show off",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/MS5f4NrzsKXVnd6u4JUwJ_4c4cbdbe5253419abcb236510aca9c30.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3bd/MXAsLDZnAeh1nnmpzai32_z3kWbtpE.mp4"
      }
    ]
  },
  "roofing": {
    "biz": {
      "agent": "Summit Roofing & Remodel",
      "headline": "Protect your biggest investment",
      "cta": "Get a free estimate",
      "brokerage": "Licensed and insured",
      "phone": "(612) 555-0109"
    },
    "shots": [
      {
        "caption": "A new roof, done right",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/43sbVGhuOTCdJzt1Pm-XK_8248e6aa2962493b8ca6f0ecd525ce53.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b7/APdq1i7bOVp7YcI34vHX4_MEtCyHyL.mp4"
      },
      {
        "caption": "Crews who care",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/z8Q_D-7bqUuHQNUfWoYZx_4ef5a639a0d84d8fa0dc15d66a002202.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3be/G_8nq_S1gGqySXiFr-DTI_CPMdyUaq.mp4"
      },
      {
        "caption": "Kitchens that wow",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/uzPJFvHsdoAdnXSUr_WjS_bb6d0f956b954e7697c730b0a4a58b3c.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3af/8R20FuKvbGYIYCulDz9c0_Cvtxzas2.mp4"
      },
      {
        "caption": "Curb appeal, restored",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/omONZ_JXcUYVXTZFzRpRe_c2631638abd64340bdb8e43cdd5422b9.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3b1/w-iB28bCkXiXD1JTonyRl_qQqY95ym.mp4"
      }
    ]
  },
  "detailing": {
    "biz": {
      "agent": "Mirror Finish Detailing",
      "headline": "Your car, showroom ready",
      "cta": "Book a detail",
      "brokerage": "Mobile service available",
      "phone": "(612) 555-0155"
    },
    "shots": [
      {
        "caption": "The foam bath",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/fMT1S8RhfVcTWryxjZYv4_933ed2217bdb479f8e8894167ce145c3.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c6/m7jAjEbgx65zHc0bttaO7_TZO9Hu6R.mp4"
      },
      {
        "caption": "Water just beads off",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/KpScLi1Ub5XAlNbQ4GLVU_8bcb28530b02496c8b6d57e88672dbab.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3be/C4MBlG7lHW1tFueyIiYLU_wBcwPL5m.mp4"
      },
      {
        "caption": "Paint correction",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/6t9Oyr8WwuMBdyOGPdohF_a3e2626923764651a72e91d09f55a811.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c5/DQGy2j1gUEgZAPU4nJp-v_zdvyCQfY.mp4"
      },
      {
        "caption": "Showroom shine",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/mXZwKwdPZqvLT2VlkCa0I_8ca39ace452340a8b6135437c496ef63.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c4/DT8jCiXDwG7-NLTQVn8x9_jFAviU6j.mp4"
      }
    ]
  },
  "landscaping": {
    "biz": {
      "agent": "Green Edge Lawn & Landscape",
      "headline": "The best yard on the block",
      "cta": "Get a free quote",
      "brokerage": "Weekly and seasonal service",
      "phone": "(612) 555-0126"
    },
    "shots": [
      {
        "caption": "Stripes the neighbors notice",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/XdZzf96z1HMQVsDnU1BF9_400f6517c11d450e8128d8c4d14b49de.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c4/Cjdbm4Kzdc6jbE1qQV3oI_DqsuWXIr.mp4"
      },
      {
        "caption": "Clean, crisp hedges",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/dxJCcw6lQPQZTNGs0fyTh_516c5bc758a54658b9beb6cbf1c1b6f2.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c4/Pn83-JUtGvH4Zqx5yQfP4_uf3drulr.mp4"
      },
      {
        "caption": "Patios like new",
        "image": "https://v3b.fal.media/files/b/0ab3c36e/XTvChBgjjAUQgSzZAc9NX_9c68d88baf7a4585aed4bb22147bbb4e.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3bd/vj17_P0d_X5X7rwmF9GEA_v1rmGHFe.mp4"
      },
      {
        "caption": "Curb appeal that wows",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/lejLVVMyx0Zur0skVgcTc_75530a07df314fee85eabe881dd81ff0.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3be/5xEfQ9PHOl5jNL_wXRxzL_hpcclb2N.mp4"
      }
    ]
  },
  "gym": {
    "biz": {
      "agent": "Iron Republic Fitness",
      "headline": "Stronger starts here",
      "cta": "Try a class free",
      "brokerage": "Open 5 AM to 11 PM",
      "phone": "(612) 555-0174"
    },
    "shots": [
      {
        "caption": "Lift heavy",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/BqPMN7YL71Q8xiiekWRzX_a80c00099dad48019b60b677d013f291.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3cc/8jD1MIcknxw_Vv3cN06KZ_hVG9w4ga.mp4"
      },
      {
        "caption": "Push your limits",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/19_K0rMrQznEPZ8YHHdJT_bba8b10d2f3540808d65784c23d2820f.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c0/8lardzLRXeLYomo1-r71P_D8RC25b9.mp4"
      },
      {
        "caption": "Ride with the crew",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/PrJgmExC5qINav_iDIVPs_0479567550f248f3b0047a4c33ad97e7.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c9/LKGWWqs-UAyn5ntrWXAxi_kb1ojj2u.mp4"
      },
      {
        "caption": "Room to train",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/KcRoXv3mB7jSOzo9O6U4Y_903a1df8da144e0a8b8bf9e095c17222.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3cd/HSuNkyUF2dhD-dpkE-KA7_g6DFlZXH.mp4"
      }
    ]
  },
  "medspa": {
    "biz": {
      "agent": "Glow Med Spa",
      "headline": "Skin that glows",
      "cta": "Book your facial",
      "brokerage": "By appointment",
      "phone": "(612) 555-0191"
    },
    "shots": [
      {
        "caption": "Your calm space",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/9yYaiwamrtUdgW8xzH_BT_978f93f39ffb42ee87cf6def5d255040.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3ce/ltM8oNrZCY5y87fiFT9IQ_output.mp4"
      },
      {
        "caption": "LED facials",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/ECCLxytz5BKo2Yib2aHTy_6495f3c865e24e76b0ba8cb1a816701c.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3c1/SNHijCwp8klSteSiue0D1_WAUEXU7r.mp4"
      },
      {
        "caption": "Clinical-grade skincare",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/R9ZW014gwNWM-9eOIPb_Q_470c7bf7ea77453b9d538b704447c5d2.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3cc/gBeTIegKcMVkI0XVyX08L_7ZVkwRkN.mp4"
      },
      {
        "caption": "Leave glowing",
        "image": "https://v3b.fal.media/files/b/0ab3c36f/obVk8W06JdTW95HZVU2Uy_53f5aae0efb1466fb1c3b33180743cb6.jpg",
        "clip": "https://v3b.fal.media/files/b/0ab3c3ca/eJuow82HtUi3qV2_eCn_v_pq5BE1u6.mp4"
      }
    ]
  }
};

// only these files can be fetched, by industry and shot number, never by a URL someone sends
export function bizExampleUrl(industry, n, ext) {
  const ex = Object.hasOwn(BIZ_EXAMPLES, industry) ? BIZ_EXAMPLES[industry] : null;
  const shot = ex && Number.isInteger(n) ? ex.shots[n] : null;
  if (!shot) return null;
  const url = ext === "mp4" ? shot.clip : ext === "jpg" ? shot.image : null;
  return url && /^https:\/\/[a-z0-9]+\.fal\.media\//.test(url) ? url : null;
}
// what the pages get: names, captions and the sample business, never the storage addresses
export const bizExamplesPublic = () => Object.fromEntries(Object.entries(BIZ_EXAMPLES).map(([k, v]) => [k, { biz: v.biz, captions: v.shots.map(s => s.caption) }]));
