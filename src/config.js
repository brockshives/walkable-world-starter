// ============================================================
// Walkable World Starter — all the knobs you'll want to tweak.
// No API keys, no accounts. Coordinates are plain meters:
//   +X = east, -Z = north (the demo hall sits at -Z from spawn), Y = up.
// ============================================================

export const SITE = {
  title: 'MY WORLD',
  tagline: 'A WALKABLE PLACE ON THE WEB',
};

// Where you land, and what you are looking at when you do.
export const SPAWN = { x: 0, y: 1.7, z: 14 };
export const LOOK_TARGET = { x: 0, y: 2.2, z: -12 };

// Player tuning — Counter-Strike movement, converted from Source engine
// units to meters (1 unit = 0.0254 m). Real CS:GO server defaults:
// sv_maxspeed 250, sv_accelerate 5.5, sv_friction 5.2, sv_stopspeed 80,
// sv_airaccelerate 12 (with the famous 30 u/s air wish cap that makes
// air-strafing work), sv_gravity 800, jump impulse ~302 u/s.
export const PLAYER = {
  eyeHeight: 1.7,
  walkSpeed: 6.35,      // 250 u/s
  runSpeed: 11.5,       // Shift — big worlds want a sprint
  accel: 5.5,           // ground acceleration (sv_accelerate)
  friction: 5.2,        // ground friction (sv_friction)
  stopSpeed: 2.0,       // friction floor (sv_stopspeed 80 u/s)
  airAccel: 12,         // air acceleration (sv_airaccelerate)
  airSpeedCap: 0.76,    // 30 u/s air wish cap — enables CS air-strafing
  jumpVelocity: 7.67,   // ~302 u/s jump impulse
  gravity: 20.32,       // sv_gravity 800
  fov: 73.74,           // CS:GO vertical FOV at 16:9 (90° on the slider)
  lookSensX: 0.0046,    // drag-to-look, rad per pixel
  lookSensY: 0.0042,
  pitchClamp: 1.45,
  headBob: 0.028,       // CS has no view bob — keep just a whisper of life
  radius: 0.45,         // collision radius
};

// Interaction distances (meters / pixels).
export const INTERACT = {
  clickMaxDist: 60,   // how far away a stand can be clicked
  promptRadius: 4.5,  // how close you must stand for the [E] prompt
  clickSlopPx: 7,     // mouse moved less than this = click, more = look-drag
};

// ============================================================
// HOTSPOTS — the clickable kiosks / posters that open links.
// Edit freely. x/z are meters.
//   url          -> opens a card with an ENTER → link (new tab)
//   menu         -> opens a link-list modal instead (sections of rows)
//   url: null    -> shows `toast` (a teaser / "coming soon")
//   indoor: true -> no tall light beacon (beacons smear across walls indoors)
//   ry           -> which way the kiosk screen faces (radians, 0 = +Z)
//   y            -> floor height for kiosks on upper floors
//   type:'poster'-> framed print on a wall (y = height on the wall)
//   privateId    -> join key into private/world-links.json: the server swaps
//                   in real names/links for authorised visitors only
//                   (see README "Keeping private links out of the bundle")
// The URLs below are harmless public examples — replace them.
// ============================================================
export const HOTSPOTS = [
  {
    name: 'WELCOME',
    desc: 'Start here: what this place is and how to move around.',
    url: 'https://threejs.org/',
    x: 4, z: 6,
    indoor: false,
    color: 0xffc233,
  },
  {
    name: 'LINK LIBRARY',
    desc: 'A kiosk with a whole menu of links.',
    x: -3, z: -20.8, ry: 0,
    indoor: true,
    color: 0x7dffb0,
    menu: {
      title: 'LINK LIBRARY',
      sections: [
        {
          title: 'BUILD TOOLS',
          items: [
            { label: 'three.js docs', url: 'https://threejs.org/docs/' },
            { label: 'Vite', url: 'https://vite.dev/' },
          ],
        },
        {
          title: 'REFERENCE',
          items: [
            { label: 'MDN — Canvas API', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API' },
            { label: 'MDN — WebRTC', url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API' },
          ],
        },
      ],
    },
  },
  {
    name: 'MEMBERS ONLY',
    privateId: 'members',
    desc: 'Private links — unlocked for authorised visitors.',
    url: null,
    toast: 'MEMBERS ONLY — OPEN THE UNLOCK LINK YOU WERE GIVEN, THEN RELOAD.',
    x: 3, z: -20.8, ry: 0,
    indoor: true,
    color: 0x62d8ff,
  },
  {
    name: 'UPSTAIRS',
    desc: 'A kiosk on the upper floor — proves the floor guard works.',
    url: 'https://developer.mozilla.org/',
    x: -9, y: 3.2, z: -15.5, ry: Math.PI / 2,
    indoor: true,
    color: 0xff8a5c,
  },
  {
    type: 'poster',
    name: 'PROJECT PAGE',
    tagline: 'click a poster, get a link',
    desc: 'Posters are quieter than kiosks: no beacon, no screen.',
    url: 'https://github.com/',
    x: 11.94, y: 2.3, z: -12, ry: -Math.PI / 2,
    floorY: 0,
    color: 0xd9a5ff,
  },
];
