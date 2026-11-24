// Reel Business Studio: the industries and the wording sent to the video model for their shots.
// Kept apart from the listing prompts so the real estate side never changes when these do.
// Same rule as listings: only what's already in the photo moves; nothing new appears; text and logos stay put.
// The general line never names an object (naming "flames" or "hands" makes the model draw them where there are none);
// what actually moves in THIS photo comes from the owner's taps (movers) and leads the prompt.

export const INDUSTRIES = {
  restaurant: { name: "Restaurant", subject: "the food",
    live: "Gentle steam and slow, natural movement of what's already there.",
    look: "Warm, appetizing light, like a premium food commercial." },
  bakery: { name: "Bakery & Cafe", subject: "the baked goods",
    live: "Gentle steam or drifting flour in the light, and slow, natural movement of what's already there.",
    look: "Warm, golden morning light, like a premium bakery commercial." },
  barber: { name: "Barbershop", subject: "the haircut",
    live: "Small, natural movements of what's already there; people stay relaxed and natural.",
    look: "Moody, warm barbershop light, like a premium grooming commercial." },
  salon: { name: "Hair Salon", subject: "the hair",
    live: "Soft, natural movement of the hair and of what's already there.",
    look: "Soft, glamorous salon light, like a premium beauty commercial." },
  nails: { name: "Nail Studio", subject: "the nails",
    live: "Subtle shine on the polish and small, natural movements of what's already there.",
    look: "Soft, clean beauty light, like a premium nail commercial." },
  roofing: { name: "Roofing & Home Services", subject: "the home",
    live: "Subtle, natural movement of what's already there, like clouds drifting or leaves stirring outside.",
    look: "Bright, clear daylight. The house, roof lines and walls stay perfectly straight and rigid." },
  detailing: { name: "Auto Detailing", subject: "the car",
    live: "Light reflections glide across the paint, with small, natural movement of what's already there.",
    look: "Glossy studio light. The car keeps its exact shape and stays rigid." },
  landscaping: { name: "Landscaping & Lawn", subject: "the yard",
    live: "Grass and leaves sway gently in a light breeze, with small, natural movement of what's already there.",
    look: "Fresh, sunny daylight. The house and paths stay perfectly straight and rigid." },
  gym: { name: "Gym & Fitness", subject: "the workout",
    live: "Controlled, natural movement of what's already there.",
    look: "Dramatic, high-contrast gym light, like a premium fitness commercial. Bodies keep natural anatomy." },
  medspa: { name: "Med Spa & Wellness", subject: "the treatment",
    live: "Calm, subtle movement of what's already there; light glows softly.",
    look: "Soft, calm, airy light, like a premium spa commercial. Skin and faces stay natural and unchanged." },
};

// a real operator varies the move from shot to shot; the Studio picks one per photo
export const BIZ_MOVES = {
  push: "Slow, smooth push-in toward SUBJECT on a steady gimbal.",
  slide: "The camera slides slowly sideways past SUBJECT on a slider, at a steady pace.",
  arc: "The camera moves in a slow, smooth arc around SUBJECT, like a gimbal orbit.",
  pull: "The camera pulls back slowly and smoothly to reveal SUBJECT.",
  macro: "Very slow macro push-in toward SUBJECT, close and shallow.",
  still: "The camera is locked off on a tripod and does not move. Only the moving things in the photo move.",
};
// shot order for a 4-photo reel: hook, process, detail, reveal
export const BIZ_PLAN = ["push", "slide", "macro", "pull"];

const RULES = "Everything in the photo stays exactly as it is: the same people, faces, hands, products, food, colors and layout. Nothing new appears, nothing disappears and nothing changes shape. Any text, signs, menus, labels or logos stay perfectly still and readable.";
export const BIZ_NEGATIVE = "new objects, new people, extra hands, extra fingers, deformed hands, distorted faces, face changing, morphing, warping, melting, changing text, garbled text, new text, new logos, watermark, color change, frame flicker, strobing, jitter, camera shake, fast motion, zoom blur, cartoon, low quality, blurry";

export const bizIndustry = kind => {
  const k = typeof kind === "string" && kind.startsWith("biz:") ? kind.slice(4) : "";
  return Object.hasOwn(INDUSTRIES, k) ? k : null;
};

// what's moving goes first: video models follow the start of the prompt most closely
export function bizPrompt(industry, move, { fix = "", movers = "" } = {}) {
  const ind = INDUSTRIES[industry] || INDUSTRIES.restaurant;
  const cam = (BIZ_MOVES[move] || BIZ_MOVES.push).replace("SUBJECT", ind.subject);
  const must = fix ? `Most important: ${fix.replace(/\.?$/, ".")} ` : "";
  const lead = movers ? `${movers.replace(/\.?$/, ".")} ` : "";
  return `${must}${lead}${ind.live} ${cam} ${ind.look} ${RULES} Only things already in the photo move; nothing new appears.${fix ? " Remember: " + fix.replace(/\.?$/, ".") : ""}`;
}
