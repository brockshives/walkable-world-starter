# Lessons learned building a walkable 3D world

This is a field guide for anyone about to build their own walkable world on this template (three.js + Vite + a small
Node/`ws` server), alone or with an AI coding assistant. It was distilled from the engineering notes of a much larger
world built on the same stack.

Every entry is a **rule** followed by the reason it exists, which is usually a bug that shipped, a complaint from a
real visitor, or an hour lost. Units are metres and seconds (1 world unit = 1 m). The numbers are tuned starting
points, not laws; change them on purpose, not by accident.

File and function names below are illustrative. Map them onto whatever your copy of the template calls its controls,
world, hotspot and server modules.

## Start from the right constraints

- **Zero config: no API keys, no accounts, no `.env` to run the world.** — The first prototype streamed photorealistic
  map tiles and needed a billing-enabled API key before anything rendered. It was scrapped and rebuilt procedurally. A
  world that needs setup before the first frame does not get cloned, shared or demoed.
- **Zero downloaded assets: geometry from primitives, textures from canvases.** — No model files, no texture packs, no
  HDRI. Everything is code, so everything diffs, everything loads instantly, and nothing has a licence to track.
- **Keep one config file for "what and where".** — Hotspots, links, spawn point and player feel live in one place with
  plain x/z metre coordinates. People who are not graphics programmers can then add a station by copying a block.
- **Optimise for the weakest machine first.** — The world was built on a top-end desktop GPU and most real visitors
  turned out to be on integrated-graphics laptops at about 40 fps. Decide early that low-end hardware is the primary
  target.
- **Believe the walk-through, not the floor plan.** — Buildings modelled at "correct" dimensions looked tiny in first
  person and were doubled. Judge scale, clutter and sight lines from eye height, in the running world.

## Movement feel

- **Use a Source/Counter-Strike-style movement model instead of constant-speed walking.** — Constant velocity feels
  floaty and dead. The values that worked: ground friction 5.2 with stop speed 2.0, ground accelerate 5.5, air
  accelerate 12 with an air wish-speed cap of 0.762 m/s (30 Source units), max walk speed 6.35 m/s (250 units/s),
  sprint about 11.5 m/s on Shift. You get crisp stops, momentum and air strafing for free.
- **Gravity 20.32 m/s², jump velocity 7.67 m/s.** — That is the Source 800/302 pair converted at 0.0254 m per unit,
  and it gives a jump apex of about 1.45 m. The earlier 18 / 5.6 pair felt like the moon. Write the apex down; level
  geometry depends on it.
- **Eye height 1.7 m; seated eye about 1.18 m on a chair, 1.26 m on a couch.** — Furniture, counters, signs and
  ceilings are all judged from this height. Changing it late makes every interior feel wrong.
- **Clip velocity against the surface when collision pushes the player out.** — Without clipping, momentum keeps
  driving into the wall, the player sticks to it, and strafing along walls feels like glue.
- **Use the Counter-Strike FOV convention: 73.74° vertical.** — That is exactly 90° horizontal at 4:3, converted with
  `vFov = 2·atan(tan(hFov/2)·3/4)`. It is the number players already have muscle memory for, and it looks right on any
  aspect ratio because three.js cameras take vertical FOV.
- **Give players an FOV slider that edits the base FOV value everything else reads.** — When the slider wrote straight
  to the camera, the sprint ease and the intro glide overwrote it on the next frame. Mutate the one base value and let
  effects derive from it.
- **Ease the FOV out when sprinting.** — `base + min(7, (horizontalSpeed − walkSpeed)·0.9)` eased with `k = 1 −
  exp(−dt/0.18)`, and only call `updateProjectionMatrix()` when the change exceeds 0.02°. A cheap effect that sells
  speed; the threshold avoids rebuilding the matrix every frame.
- **Mouse handlers set look *targets*; the frame loop eases the camera onto them.** — Mouse events arrive between
  frames in uneven slices, so applying yaw/pitch per event produced visible micro-jitter on slow pans. Ease per frame
  with `k = 1 − exp(−dt/0.04)` (about 40 ms, imperceptible lag) and wrap yaw along the shortest path.
- **Programmatic camera moves must snap the smoothing state too.** — Spawn, respawn, teleports and the intro glide
  need an "apply instantly" path that also syncs the smoothed yaw/pitch, or the camera swings back to a stale target.
- **Offer pointer lock, and always fall back to plain drag.** — Hold right mouse to request pointer lock and read raw
  `movementX/Y`; if the browser refuses the lock (it throttles after a quick Esc), run the ordinary drag path on the
  same press so looking never breaks.
- **Add a sticky mouse-look toggle with a crosshair.** — Holding a button for minutes is tiring. A toggle key locks
  the pointer, shows a centre dot, makes left click interact at screen centre, and makes hover prompts track the
  crosshair instead of the hidden cursor.
- **Release the lock whenever any UI opens, and re-acquire it when the UI closes.** — A locked pointer cannot click a
  modal. Remember that the lock was stolen and re-request it inside the same user gesture that closes the panel (the
  click, or Esc key-up deferred about 50 ms); otherwise visitors re-press the toggle after every kiosk.
- **Only the left button counts as a click, and a click is a press that moved under 7 px.** — A right-button release
  used to fire a portal click after every look-around, and without a movement threshold every drag opened whatever was
  under the cursor.
- **Add a mouse sensitivity slider (0.3–2.5, default 1) applied in every look path.** — There were four look paths
  (lock and drag, X and Y). Missing one gives an axis that ignores the setting.
- **Head bob and step smoothing are camera-only offsets, removed before physics runs.** — If the offset leaks into the
  position that collision uses, the player slowly drifts or bounces. Add after physics, subtract before the next step.
- **Soften hard landings.** — On landing with vertical speed below −5.5 m/s, inject `min(0.16, (−velY − 5.5)·0.02)`
  metres into the step-smoothing offset. It reads as knees absorbing the drop and costs three lines.

## Collision and level geometry

- **Collision is a flat list of axis-aligned boxes plus a circle pushout for the player.** — Two relaxation passes per
  frame resolve corners. It is simple, fast, debuggable and enough for a building-scale world; no physics engine
  required.
- **Collider tops are standable.** — A `groundHeightAt(x, z, feet)` query that returns the highest collider top under
  the player lets visitors jump onto desks, crates and cars. Worlds where every object is an invisible wall feel fake.
- **Add an explicit step-up: collider tops within 0.21 m above the feet count as ground.** — Automatic step-up did not
  exist at first, and the first staircase stranded players inside step one. With `STEP_UP = 0.21`, stacked boxes
  become stairs.
- **Stair dimensions that work: rise about 0.19 m, tread 0.30 m.** — Seventeen risers of 0.189 m reach a 3.22 m upper
  floor. Keep the rise safely under the step-up threshold.
- **Glue the player to descending stairs.** — If grounded, not moving upward, and the ground is at most 0.5 m below,
  snap the feet down instead of free-falling off every tread. Without it, walking downstairs is a series of tiny
  falls.
- **Smooth the camera over steps with a decaying offset.** — Feed each snap into an accumulator that decays with
  `exp(−13·dt)` and is clamped to ±0.55 m; camera height is `feet + eye − offset`. Zero it on jump. Stairs then glide
  instead of popping.
- **Give the stair smoother a 1 cm dead zone.** — Micro-steps should snap without engaging the smoother, or flat
  floors with tiny height noise shimmer.
- **Compare ground height against the feet position from *before* gravity is applied.** — At low frame rates gravity
  sinks the feet `g·dt²` below the floor each frame (1.3 cm at 40 fps), which exceeded the 1 cm step threshold, so the
  climb smoother fired every frame and the camera vibrated constantly. It was invisible at 144 fps. Any threshold on
  an integrated quantity needs a pre-integration baseline.
- **Room-sized overhead colliders must never act as pushout walls.** — A jump under a mezzanine put the head inside
  the slab's height band, the slab activated as a wall, and deepest-axis pushout teleported the player to the slab's
  nearest edge: through the room wall. Skip any collider whose underside is more than 1.2 m above the feet.
- **Handle ceilings with a head bump instead.** — Add `ceilingHeightAt(x, z, feet)` returning the lowest collider
  underside at least 0.5 m above the feet, cap the feet at `ceiling − (eye + 0.15)` and zero the upward velocity.
  Jumps then stop cleanly under slabs and the camera never clips into them.
- **Check upper-floor height against the ceiling: floor top + jump apex + eye height.** — With a 6.4 m ceiling, a 3.22
  m slab leaves 3 cm of clearance (3.22 + 1.45 + 1.70 = 6.37). A slab at 3.3 m would have put jumping heads through
  the roof.
- **Walk-test every staircase in both directions before calling it done.** — One stair's base was sealed off by its
  own balustrade and newel post. It looked fine in screenshots and was only caught by an automated walk test.
- **Never put colliders on a stair landing.** — A decorative planter on a 0.95 m landing walled off the descent
  completely.
- **Railings and glass walls must cover their full height.** — Lower glass colliders that stopped at 3.35 m left an
  open gap that upper-floor visitors could fall through. When you add a floor, re-check every collider that was "tall
  enough" before.
- **Every collider needs something visible, and every visible wall needs a collider.** — An entrance face had
  colliders with no geometry at ground level; visitors reported invisible walls. Glass must also render from both
  sides (`DoubleSide`) or it vanishes from inside the building.
- **Tag glass colliders `seeThrough`.** — They block movement but must be skipped by line-of-sight tests, or labels
  behind glass get ghosted as if behind brick.
- **Keep walk lanes clear.** — Benches, planters, a reception desk and a dispenser were all removed after visitors
  bumped into them. Decoration belongs against walls and in corners; the routes between spawn, doors, stairs and
  stations stay empty.
- **Sittable furniture is a registry entry, not a static collider.** — Chairs register in a list and the player can
  sit with the interact key. For fixed seats such as couches, pin the camera and pause physics while seated, because
  the couch's own collider otherwise ejects the sitter.
- **Re-check the spawn point after every layout change.** — New geometry landed on the spawn spot more than once. Keep
  the server's default pose for not-yet-reported players in sync with the client spawn as well.

## Building the world procedurally

- **Paint detail into canvas textures instead of modelling it.** — Bevels, panel lines, planks, grout and rack faces
  drawn on a 2D canvas look convincing at walking distance and cost one draw call. No normal maps were needed
  anywhere.
- **Get reflections from a generated environment, not an HDRI file.** — A PMREM-filtered procedural room environment
  at intensity 0.28–0.35 gives wood and metal a satin sheen. Pair it with ACES filmic tone mapping at exposure about
  1.15.
- **Skip the bloom pass.** — A full-screen composer costs frame rate on every machine; tone mapping plus emissive
  materials already make lights pop.
- **Clone tiling textures per wall and set the repeat from the wall's length.** — One shared texture with one repeat
  value stretches on every wall that is not the reference size. Clone the texture, share the image.
- **Build figures from capsules and spheres, not boxes.** — Boxy statues and avatars drew an immediate "looks like a
  block game" reaction. Capsule limbs laid joint to joint with quaternions and 26-segment spheres read as sculpted.
- **Use one un-mirrored texture for both sides of a box.** — three.js box faces already flip U per side. Pre-mirroring
  the texture for the "other" side made vehicle lettering read backwards.
- **Curve display boards around pillars instead of mounting flat planes.** — Cylinder segments (open-ended, about 28
  radial segments) stay readable at oblique walking angles where flat boards turn to mush. Raycasting works on curved
  meshes unchanged, and the outside of a cylinder samples its texture un-mirrored, so no repeat flip is needed.
- **Water is an opaque plane sitting *above* a shoreline ring.** — Twice, a filled sand disc intended as a rim covered
  the water plane and the pond looked like pavement. Make the shore a ring, put the water at about y 0.02 on top, and
  animate the texture offset.
- **Layer wall-mounted things at deliberate offsets.** — Liner panels sit 0.005 m off the wall and everything mounted
  on them sits 0.03 m or more off, so signs always win the depth test. Pick offsets once and reuse them.
- **Two coplanar surfaces that overlap will z-fight; move one.** — A sign overlapped a poster by 0.4 m on the same
  wall and shimmered. There was no room at that height, so the fix was moving it, not nudging depth.
- **For true decals, use `polygonOffset` rather than large gaps.** — Floor markings and wall graphics that must hug a
  surface can set `polygonOffset: true` with small negative factor/units; visible gaps look wrong at grazing angles.
  (Standard practice, included for completeness.)
- **Skins that float off a wall leave gaps at corners, doors and the ceiling line.** — Wall panels 0.26 m off the
  structure exposed raw wall in every notch. Cover them the way real buildings do: corner posts, door casings and
  crown moulding.
- **Check sign tops against beams and ceilings.** — Tall signs poked through ceiling beams more than once. Know your
  beam underside height and keep sign tops under it.
- **Never hang or orbit anything in front of a sign or screen.** — Pendant lights blocked header signs, and a
  decorative ring at screen radius occluded the tops of display boards from every distance. Widen or raise the
  decoration.
- **Always set a kiosk's rotation, and confirm its screen faces open floor.** — Pedestals were placed backwards, and
  one stood in a 15 cm gap behind a counter facing glass, so it could not be used.
- **One config field, one meaning.** — A `y` field meant "floor lift" for free-standing kiosks and "wall height" for
  wall-mounted tiles. Applying it in a shared code path doubled every wall tile's height and put them in the rafters,
  unclickable.
- **Additive glow beacons belong outdoors only.** — Indoors, a translucent additive cylinder over every kiosk rendered
  as a beige slab across walls, and glow leaks through walls from outside.

## Lighting and materials

- **Interior floors need roughness of at least 0.7.** — The outdoor directional sun is not occluded by your roof;
  lighting itself does not test for occluders. A floor at roughness 0.4 caught a giant white specular blob indoors.
  Rougher floors with a little environment sheen still look alive.
- **Interior floors need albedo of about 0.6 or lower.** — A cream floor at about 0.93 albedo under that same
  un-occluded sun blew out to white and cancelled the warm interior lighting. Mid-tone wood fixed it.
- **Budget point lights: about 14–16 for a large interior.** — Every `PointLight` costs every lit fragment. Past the
  budget, frame rate falls on all hardware.
- **Lamps, coves and light fixtures are emissive materials, not lights.** — A lamp shade with an emissive or unlit
  material reads as lit. Spend real lights only on the pools that shape a room.
- **Make very large translucent shells opaque.** — Large transparent surfaces with `depthWrite: false` near the camera
  are a fill-rate disaster on integrated GPUs.
- **Dark flecks in a light floor read as dirt.** — Keep terrazzo chips in the same pastel family as the base, and
  grout lines at 2 px or less and 30% alpha or less. Heavier grout became "black lines everywhere".
- **Warm beats sterile.** — Cool white fixtures made a room feel cold and unwelcoming. Fixture colours around
  `0xffedd0`, glow accents around `0xffd9a0` and cream walls made the same geometry feel inviting.

## Signs, text and screens

- **A sign's canvas aspect ratio must match its plane.** — The default sign canvas was 1024×128 (8:1). Boards of
  1.3×0.95 m that used it had their text stretched six times vertically. Any sign far from the default ratio passes
  its own canvas width and height.
- **No drawn outlines on light signs.** — A thin border painted on a light canvas shimmers into broken black lines at
  grazing angles. Set the border width to 0 and give the sign a real box behind it as a frame.
- **Scale floor-decal canvases with the mesh length: about 400 px per metre, capped at 4096.** — A fixed 1024 px
  canvas stretched over a long runner distorted the lettering and let glyph tails spill outside the band.
- **Clamp label sprites by distance.** — `scale = base × clamp(distance / 7, 0.3, 1)`. Fixed-size sprites fill the
  screen when you walk up to them.
- **Never layer two rotating copies of the same text.** — A counter-rotating additive "bloom" copy of a marquee
  overlapped and garbled the crisp letters. One copy; bake glow into the texture.
- **Text shells are `FrontSide` only, with a dark `BackSide` shell behind them.** — `DoubleSide` text shows mirrored
  lettering from behind and bleeds the far side through.
- **Double-faced hanging signs are two front-facing planes sharing one texture.** — Each is rotated to face outward,
  so neither side is mirrored and one redraw updates both.
- **For repeating text rings, size the canvas to the measured text width and keep the repeat an integer.** — Otherwise
  the seam cuts a word in half. Redraw on `document.fonts.ready`, because the first paint used a fallback font with
  other widths.
- **Supersample text canvases 2×.** — Double the canvas size and apply `setTransform(2, 0, 0, 2, 0, 0)` once; every
  painter keeps its original coordinates and the text is twice as sharp. Build at 1× on low graphics tiers.
- **Text-bearing textures get anisotropy 16; decorative ones stay at 4.** — Anisotropic filtering is *the* fix for
  oblique text mush. three.js clamps to the GPU maximum, so 16 is safe; capping decorative surfaces at 4 halves the
  worst-case taps on weak GPUs.

## Performance

- **Draw submissions are the frame-rate ceiling, not triangles.** — A scene of 2,155 visible meshes, 770 unique
  geometries and only 131k triangles ran at 82 fps on a flagship GPU with 1,763 draw calls. Measure
  `renderer.info.render.calls` (it does not include the shadow pass) before optimising anything else.
- **Batch static boxes.** — Route box creation through one helper that queues geometry and merges it per material and
  shadow flag when the world finishes building. Transparent materials and anything created after the flush stay as
  live meshes. One corner view went from 1,763 to 1,225 calls.
- **Exclude animated and clickable meshes from merging.** — Doors, chairs, NPCs and raycast targets must stay
  individual. Verify that no call site keeps a reference to a mesh that is about to be merged.
- **Merge materials inside repeated props.** — A chair built from 16 meshes became 3 by merging per material. Multiply
  that by every chair in the world.
- **Distance-cull small meshes.** — Hide meshes with a bounding radius under 0.5 m beyond 24 m, re-evaluated every 0.2
  s. Mark permanently hidden objects with a flag the culler must never revive.
- **Shadow map 1536 instead of 2048.** — The cheapest safe shadow win; visually identical at walking scale.
- **Update the shadow map at half rate, and drive `needsUpdate` yourself.** — Setting `shadowMap.autoUpdate = false`
  without ever setting `needsUpdate` white-screened the whole world in production: every lit material vanished and
  only unlit ones survived. The safe version sets `needsUpdate = true` every second frame.
- **Never ship a renderer or lifecycle change without a rendered-pixels check.** — That incident passed a build and a
  console check. A headless screenshot that someone actually looks at would have caught it (see the testing section).
- **Resize shadows at runtime with `mapSize.set()`, then dispose the map and null it.** — That path is safe. Do not
  toggle `renderer.shadowMap.enabled` at runtime; turn shadows off by flipping `castShadow` on the light.
- **Cap device pixel ratio at 1.5.** — Going from a cap of 2 to 1.5 was the single biggest win and nobody noticed the
  quality change. High-DPI screens otherwise shade nearly twice the pixels.
- **Add an automatic performance ratchet.** — Track an FPS moving average (seed 55, gain 0.08). Under 48 fps for 2.5
  s: pixel ratio 1.25 plus the low-detail tier. Under 34 fps: pixel ratio 1.0. A single threshold at 32 gave 45–58 fps
  laptops no relief at all.
- **The ratchet is one-way and only ever lowers quality.** — Stepping back up causes oscillation. Make the resize
  handler preserve the current ratio too.
- **Persist the tier and apply it at boot.** — Otherwise every visit starts with several seconds of stutter before
  adapting. A manual quality setting disables the ratchet; "auto" clears the remembered tier and re-measures.
- **Only pre-flag true software renderers as weak.** — A GPU-name heuristic that matched capable integrated chips
  dropped them to pixel ratio 1.2 and smaller shadows, which made everything shimmer on slow pans. Match software
  rasterisers only and let the FPS ratchet judge real hardware.
- **Define tiers by what they remove.** — Tier 1: 1024 shadows, meshes under 0.6 m leave the shadow pass, canvas
  screens repaint less often. Tier 2: only landmarks over 2.5 m cast shadows and untextured micro-props under 0.22 m
  are hidden. Lowest: shadows off, the 6 strongest point lights of about 19 kept, ambient raised to compensate.
- **MSAA is chosen at context creation.** — `antialias` cannot change after the renderer exists, and MSAA buffers cost
  hundreds of MB on integrated GPUs (their video memory is system RAM). Read the saved tier *before* creating the
  renderer; a quality change therefore needs a reload.
- **Debounce any setting whose commit is a reload.** — A cycle button that reloaded on every click turned "low to
  high" into two reloads. Let clicks cycle freely and commit 1.1 s after the last one.
- **Precompile shaders before enabling the Enter button.** — The first render compiles every shader and uploads every
  texture, freezing the tab for seconds and swallowing clicks. Call `renderer.compileAsync(scene, camera)` at boot,
  keep the button disabled with a loading pulse until it resolves, and add a 12 s backstop.
- **Throttle live canvas screens and never repaint them in the same frame.** — Repainting every wall screen at once,
  including one 1536×691 canvas (a 4 MB upload), produced a rhythmic stutter every 0.75 s. Repaint one screen per 0.2
  s tick, round-robin.
- **Give small animated screens a budget and a distance gate.** — Kiosk CRTs repaint at about 3 fps, at most 4 per
  tick, and only within 28 m. Repainting all of them every 330 ms felt choppy even at 140 fps.
- **Round-robin per-label occlusion tests.** — Testing every label against every collider each frame was over 500,000
  slab tests per second. Test 8 labels per frame (4 on the low tier) and cache the result; worst-case staleness is
  about 120 ms.
- **Never put `backdrop-filter` over the live canvas on an interactive panel.** — The GPU re-blurs the animating world
  every frame the panel is open, and scrolling inside it lags. Use a darker solid veil.
- **Batch streamed text into one DOM write per animation frame.** — Appending a node per token forced a layout per
  token (hundreds per reply). Accumulate and append to a single text node once per frame.

## Interaction and UI

- **Two ways to activate everything: walk close and press E, or click it.** — Some visitors never find the key and
  some never find the mouse. Show a `[E] NAME` prompt when in range.
- **Wall-mounted tiles prompt on hover, not proximity.** — A wall of 15 tiles within reach cannot each claim the E
  prompt. Give them a zero prompt radius and let the hovered one take the key.
- **Ghost labels through walls instead of hiding them.** — Cast a segment from the camera to each label against the
  collider boxes; if blocked, ease opacity to 0.08. Labels stay useful for wayfinding without shouting through walls.
- **Guard prompts by floor in multi-storey spaces.** — Skip any hotspot whose floor height differs from the player's
  feet by more than 1.6 m. Two kiosks 4 m apart in plan but on different floors otherwise steal each other's prompt.
- **One sign per station.** — A title sign plus a separate placard collided with the neighbouring station's sign.
  Merge title and subtitle into one sign.
- **Size modal panels in `em` from a single `clamp()` base font size.** — For example `--base: clamp(19px, 1.08vw,
  42px)` with `width: min(94vw, 46em)` and every child in `em`. Fixed-pixel panels were postage stamps on 4K monitors;
  this occupies the same share of the screen at 1080p, 1440p and 4K.
- **Clamp restored panel sizes to the current viewport.** — A width saved on a 4K display pushed the panel's content
  off a 1080p screen. Let wide content wrap below instead.
- **Typing in any input must never move the player or fire hotkeys.** — The single "is UI open" check has to include
  every text field: chat, search boxes, helper panels.
- **A hotkey handled before that check needs its own typing-field test.** — The help key was deliberately handled
  early so it could close the help card, and so typing its letter in a chat box toggled the card behind it. Check for
  `INPUT`, `TEXTAREA` and `contenteditable` targets.
- **Be careful with `stopPropagation` on inputs.** — It is the easy way to shield an input from world hotkeys, but it
  also kills any global hold-to-talk key that the same input relies on.
- **Non-modal panels pause movement only while their input is focused.** — A small always-available helper panel
  should let people keep walking with it open; Esc blurs it.
- **A mute switch outranks every other heuristic.** — "A spoken question deserves a spoken answer" overrode the mute
  toggle and annoyed people. Off means off until it is clicked back on.
- **Funnel every URL through one validator before it reaches `href`, `window.open` or the clipboard.** — Allow only
  `http:`, `https:` and same-origin paths, and open external links with `noopener,noreferrer`. A poisoned data source
  then cannot inject `javascript:` URLs.
- **Remote strings go into `textContent`, never `innerHTML`.** — Chat, display names and AI replies are all
  attacker-controlled text.
- **CSS cannot animate flex redistribution when siblings are added or removed.** — Lock every column at its measured
  pixel width *before any DOM change*, animate to the new shares, then release back to flex. Animate removed siblings
  closed; never hard-remove.
- **Stick to the bottom of a streaming log only when the reader is already there.** — Auto-scroll within 48 px of the
  bottom; never yank someone who scrolled up to read.

## Multiplayer

- **One in-memory Node + `ws` process is enough for presence.** — Clients send poses; the server broadcasts state rows
  at 10 Hz, for example `[id, x, y, z, yaw, voiceFlag, seat]`. No database, no accounts. Cap clients (64), reap dead
  sockets with pings, clamp every numeric input.
- **Because presence is in memory, run exactly one server instance.** — Two instances means two worlds that cannot see
  each other.
- **The client must work with no server.** — Retry the socket quietly; the world is simply single-player. Local
  development should not require the server.
- **Ghost avatars should be nearly opaque and clearly face forward.** — At opacity 0.42 ghosts were hard to see; 0.92
  worked. Give them a feature such as a cap brim that shows facing, and verify the facing convention with a two-client
  test (body forward is −Z and `rotation.y` equals yaw).
- **Sync posture, not just position.** — A seated player looked sunk into the floor with no chair to other clients
  until the pose carried a seat flag (0 standing, 1 chair, 2 couch) and ghosts drew their own chair. Remember the
  sender's y is lowered by the seated eye height.
- **Rate-limit chat per connection (6 messages per 10 s) and sanitise it.** — Printable characters only,
  length-capped, rendered as text.
- **Size the WebSocket payload cap for your largest legitimate message.** — 512 B was fine for poses, 2 KB for
  mini-game packets, and 16 KB once WebRTC session descriptions were relayed.
- **Proximity voice is a WebRTC mesh signalled over the same socket.** — Relay opaque offers and candidates; the lower
  id dials to avoid glare; connect to at most the 8 nearest peers; redial after a 12 s stuck-handshake watchdog.
- **Use hysteresis for connect and drop.** — Connect within 14 m, drop beyond 18 m, so people standing at the boundary
  do not reconnect continuously.
- **Voice gain falls off with distance: full within 2.5 m, silent at 9 m.** — That gives desk-conversation intimacy
  instead of a world-wide party line.
- **Compute voice distance in 3D.** — A horizontal-only distance let people on stacked floors hear each other at full
  volume.
- **`Permissions-Policy` must allow the microphone for your own origin.** — A hardening header of `microphone=()`
  blocked the site's own `getUserMedia`. Use `microphone=(self)`.
- **In Chrome, attach each remote stream to a muted `<audio>` element.** — Without it, the Web Audio graph receives
  silence.
- **STUN-only meshes fail on some networks; say so.** — Strict firewalls and VPNs silently break peer pairs. Show a
  "voice pair blocked" toast (with a cooldown) rather than nothing. The real fix is hosting your own TURN relay; do
  not route voice through random free public ones.
- **Mini-games are host-authoritative and relayed, not simulated by the server.** — The server forwards opaque `{type,
  room, data}` packets stamped with the sender id, with a 40 messages/s flood guard. The lowest id in the room hosts
  (or the current shooter, for turn-based games) and streams state at about 12 Hz.
- **Mirror live games onto the 3D props.** — Moving the real table's balls and repainting the cabinet screens lets
  bystanders watch. Decay back to an idle pose about 6 s after the last packet.

## NPCs and ambience

- **NPCs are desk-first.** — Wandering crowds look aimless. Have each NPC walk to a desk on load, sit with about 92%
  odds for 7–14 minute shifts, and use stand-ups to visit stations such as a copier or water cooler.
- **Chairs carry ownership flags.** — One flag for "a player is sitting", one for "an NPC claimed this"; the interact
  scan and NPC seat search skip both. Otherwise two bodies share a chair.
- **Every sit has a guaranteed stand timer, and a stuck abort releases the chair.** — Otherwise chairs leak and
  eventually nobody can sit.
- **Stuck recovery teleports to the current waypoint; it never skips waypoints.** — An uninitialised stuck timer fired
  every frame and skipped the whole scripted path, so the state machine believed the NPC was indoors while it jogged
  against an outside wall. Initialise the per-NPC stuck fields in the factory.
- **Prefer the simple behaviour that cannot break.** — A scripted walk through automatic doors kept failing; NPCs that
  park and chat outside forever were more charming and have no failure modes.
- **Sky ambience is sprites, not lights.** — An occasional aircraft with a blinking strobe, a bright satellite pass at
  night, shooting stars: all glow sprites on timers (minutes apart), costing nothing.
- **Drive day and night from the real sun.** — Compute sun elevation from the clock and a configured location, derive
  a single 0–1 "nightness" value, and expose it so sky colour, moon, stars and night-only ambience all read the same
  number. Put the moon opposite the sun and fade it with cloud cover.

## An in-world AI helper

- **Proxy the model API through your server; the key is a server secret.** — A plain `fetch` to an OpenAI-compatible
  chat-completions endpoint is enough, with no SDK. The key never appears in the bundle, the repository or the image
  layers.
- **Use a prepaid balance with auto top-up off as the hard bill cap.** — Software limits can have bugs; an empty
  balance cannot be overspent.
- **Layer the software limits anyway.** — For example 30 messages/minute per IP, a per-IP daily soft cap (400), a
  global daily cap (2,000), a token ceiling, an upstream timeout, and server-side re-validation of any history the
  client sends.
- **Always have a canned fallback, and label which brain answered.** — With no key, an exhausted cap or an upstream
  error, a scripted keyword persona replies instead of silence. Return a `source` field so you can tell them apart
  when debugging.
- **Decide who gets the paid model.** — Serving anonymous visitors the canned persona and reserving the real model for
  authorised visitors removes denial-of-wallet entirely. Validate any client-chosen model id against a server-side
  allowlist.
- **Kiosk context is a server-side lookup key.** — The client sends a station id; the server maps it to context text.
  Client-supplied text never enters the system prompt.
- **Treat the knowledge file as public.** — Anything in the base knowledge file can be spoken to any visitor. Keep a
  separate file that is appended only for authorised requests.
- **Models over-follow flavour instructions.** — Told it was a robot that beeps, one model opened *every* reply with a
  beep. State frequency limits explicitly ("at most once per four or five messages, never as the first word").
- **Raw API models need explicit eagerness about tools.** — Given a status tool, models answered from the first status
  line and stopped. The prompt and the tool description both had to say that a status line is not an answer and to
  investigate by default. Chat products bake this in; raw APIs do not.
- **Stream; do not bolt deadlines onto a blocking request.** — A multi-round tool loop outlived the hosting proxy's 60
  s idle limit and the connection was cut. Deadline guardrails made things worse. Streaming newline-delimited JSON
  events (`delta`, `tool`, `reset`, `ping`, `done`) fixed it properly; only runaway caps remain (12 rounds, 3 min).
- **If you must long-poll, send a heartbeat.** — Write the 200 header immediately and a space every 10 s; leading
  whitespace is legal JSON, so `response.json()` still works.
- **A fallback provider without tools must be told the tools are offline.** — Otherwise it reads the persona, sees
  tools advertised and hallucinates tool-call syntax as text.
- **A server-side URL-fetch tool is a real SSRF surface.** — Allow http(s) only, reject local hostnames, check DNS
  answers against loopback/private/link-local ranges *before* connecting, re-validate every redirect hop (max 4), cap
  time (12 s) and size, and reject non-text content types.
- **If the panel renders plain text, ban markdown in the prompt and strip it server-side too.** — Models ignore the
  ban on long answers. Also collapse the blank lines models put between list items, and unit-test that regex on three
  or more consecutive items; a first version only collapsed every other one.
- **Size limits must be consistent end to end.** — Replies were "cut off" by a 500-token ceiling, pasted documents
  were chopped by a 500-character input cap, and a history-item cap truncated context. Raise the input `maxlength`,
  server caps and token ceiling together.
- **`speechSynthesis.cancel()` fires the current utterance's `onend`.** — A chained queue re-armed itself after mute.
  Flip your own "speaking" flag and bump a generation token *before* cancelling, and have each chunk check the token.
- **Speech recognition is not available in every browser.** — Feature-detect and show a toast. In continuous mode,
  send only after about 2.2 s of silence; sending on the first pause was far too twitchy. Stop transcribing while the
  helper is speaking.
- **Tell people where their words go.** — Everything typed is sent to the model provider under that provider's logging
  policy. Say so in the panel.

## Live data boards

- **Fetch public feeds on the server, cache them, and serve one combined endpoint.** — A 5-minute cache prewarmed at
  boot keeps visitor load off upstream APIs, hides any keys, and means every client sees the same board.
- **Serve that endpoint with `Cache-Control: no-store`.** — A cacheable copy from an older build painted half-empty
  boards after a deploy. Cache on the server, not in browsers.
- **Budget on-demand upstream calls globally.** — Whitelist inputs (enums and a symbol regex), cache for 2 minutes,
  and return 429 beyond about 30 upstream fetches per minute, so a flood cannot turn your server into a scraping proxy
  or get its address banned.
- **Force IPv4-first DNS on the host if feeds work locally but fail in production.** —
  `dns.setDefaultResultOrder('ipv4first')` at server start fixed feeds that showed "no data" only on the hosting
  platform, where egress preferred IPv6.
- **Check a feed's encoding before parsing.** — One large cloud provider's public status feed is UTF-16BE with a BOM
  (`FE FF`) and needed an explicit decoder. Also check whether timestamps already carry an offset: appending `Z` to
  dates ending in `+00:00` breaks them.
- **Free tiers have range caps.** — CoinGecko's free market-chart endpoint stops at 365 days, so there is no "max"
  range; hide the button rather than show an error.
- **Some APIs require a `User-Agent` header.** — The US National Weather Service alerts API rejects requests without
  one.
- **Deduplicate alerts.** — One weather warning spans many zones; without deduping by event and area, three copies of
  one alert crowded out a different one.

## Keeping private data out of a public bundle

Use this pattern when the world is public but some labels and links are only for authorised visitors.

- **Everything in the client bundle is public. Redact at build time.** — Any label or URL baked into the JavaScript is
  readable by anyone who loads the page, whether or not the links themselves need a login. The public build should
  carry only generic labels ("DOCUMENTATION", "TOOLS").
- **Real labels and links live in a server-side JSON file, served by one gated route.** — Keep it in a `private/`
  folder that is git-ignored (this repo ships a `private.example/` placeholder). The client fetches it after boot; on
  success, hotspots and signs redraw with the real text. Unauthorised visitors get a 403 and a "restricted" toast.
- **Authorise by IP allowlist or by an unlock cookie.** — A one-time unlock link sets an `HttpOnly; Secure;
  SameSite=Lax` cookie (180 days) and redirects home. The token is a platform secret: 192 random bits from a
  cryptographic generator.
- **Know what this is.** — One shared token means no per-user identity and no individual revocation; rotating the
  secret invalidates every cookie at once. It reduces what a stranger can learn. It is not an identity system, and
  every protected link should still sit behind its own login.
- **Trust only the hosting platform's client-IP header.** — `X-Forwarded-For` is attacker-controlled. Read the header
  your platform's edge sets (on Fly.io, `Fly-Client-IP`) and nothing else. In this template the server trusts a proxy
  header only if you name it in `TRUST_PROXY_HEADER`.
- **Compare tokens in constant time.** — Use `crypto.timingSafeEqual`.
- **Rate-limit the unlock route.** — 20 attempts per minute per IP, then 429.
- **IP allowlists are brittle; the cookie is the durable path.** — Addresses change with VPNs, mobile networks and
  shared egress pools. Allow ranges rather than single addresses, and remember an address proves a network, not a
  person.
- **Grep the built output, not the source.** — Run a case-insensitive scrub grep over `dist/` for every sensitive term
  and expect zero hits.
- **Identifiers survive minification.** — Class method names and property keys ship verbatim. A method named after a
  confidential label puts that label in the bundle even though no string contains it. Name code after what it is,
  not whom it is for.
- **Leaks hide in decoration.** — Typical hiding places: internal ids, text painted on decorative canvases, fake "search
  queries" on prop monitors, wall posters, and menus added in a hurry. Review anything that draws text.
- **Tune the scrub list against false positives instead of ignoring them.** — A short product name matched a common
  font-family string, and a harmless minified property name matched another term. Narrow the pattern or rename the
  identifier; never get used to a failing grep.
- **Gate deploys on the scrub grep.** — The check only works if it cannot be skipped.
- **Mask data feeds too.** — A public JSON endpoint can leak the same names the bundle hides. Serve generic row labels
  ("INTERNAL TOOL") to unauthorised callers and real ones after unlock.
- **The Dockerfile must explicitly copy new top-level directories.** — The runtime stage copied only the build output
  and the server file, so the first gated deploy silently answered "locked" to everyone because `private/` was not in
  the image.
- **Mark the gated route `no-store`, and never ship source maps publicly.**
- **Send security headers on every response.** — HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy` (allowing the microphone for self if you use
  voice), and a CSP: self-only scripts, your font host, `data:`/`blob:` images, `ws:`/`wss:` connections,
  `frame-ancestors 'none'`, `base-uri 'self'`.
- **Harden the static file server.** — Normalise the path and verify it stays under the web root before reading.
- **World chat is a public channel.** — Anyone connected can read it, including anonymous visitors. Say so in the UI
  if authorised people use the same world.

## Testing headlessly

- **Expose a debug handle.** — For example `window.__world = { camera, controls, renderer, hotspots, games, ambience
  }`. Every test below depends on it, and it is how an AI assistant "sees" the world.
- **Load with `waitUntil: 'domcontentloaded'`.** — `networkidle` never resolves while a live WebSocket is open.
- **Wait for the debug handle before clicking Enter, then for the HUD to show the walking state.** — The click
  listener attaches after font preload, and the intro glide keeps lerping the camera. Headless runs at about 9 fps, so
  a 3 s glide takes about 7 s of wall time.
- **Drive `controls.update(1/60)` in a synchronous loop for movement tests.** — At 9 fps the player strides 0.68 m per
  frame and cannot climb 0.3 m treads, so real-time input is useless. Stepping the controller gives deterministic
  walks, jumps and stair climbs.
- **Teleport and assert.** — Set `camera.position`, set the look direction, step the controller, then assert numbers:
  feet height at the top of the stairs, maximum y during a jump, horizontal drift while jumping against a wall (must
  be zero).
- **Fast-forward schedules by calling `update` directly.** — The headless clock ran about 13× compressed and
  `waitForTimeout` told nothing about in-world timers. Calling `ambience.update(0.05)` 3,000 times is 150 in-world
  seconds.
- **Keep a rendered-pixels check and run it before any renderer change ships.** — Serve the production build with the
  real server, enter the world, screenshot, and *look at the image* along with console errors. An expected 403 from
  the gated route is fine.
- **Screenshot from several teleported angles for layout changes.** — Three or four views catch occluded signs and
  blown-out floors that code review cannot.
- **Use `fill()`, not `type()`.** — `page.type()` timed out against the busy animation loop.
- **Test chat and voice with two browser contexts.** — Launch Chromium with the fake media-stream flags, then assert
  chat arrives both ways, the peer connection reaches "connected", and gain falls to 0 as the avatars separate.
- **Keep a ten-second smoke test.** — It repeatedly caught "cannot access before initialization" crashes caused by
  code using a `const` declared further down a long setup function. Minified, that error names a meaningless variable.
- **Turn each fixed bug into a check.** — The regression script grew to a ground-height grid, stairs up and down,
  railings, cross-floor prompts and jump apex: 28 checks in a few seconds.

## Deploying

- **One container: the static build and the Node server together.** — The server serves `dist/`, the WebSocket and the
  API routes on one port (8080 internally). A separate static host only adds CORS and proxy problems.
- **Run a single machine with high availability off.** — Presence, chat, rate limits and caches are in memory. On
  Fly.io that means deploying with `--ha=false`.
- **All keys and tokens are platform secrets.** — Never in the repository, the image, or a chat with an assistant; if
  one is pasted somewhere, rotate it.
- **Hosting proxies cut idle connections at about 60 s.** — Keep upstream waits under 55 s, or stream, or heartbeat.
- **Verify production after every deploy.** — Site returns 200, the new bundle hash is live, the gated route returns
  403 anonymously, and the scrub grep passes against the deployed bundle, not only the local build.

## Working with an AI assistant

- **State the hard constraints once, up front.** — "No API keys, no downloaded assets, must hold frame rate on a
  laptop." The assistant will otherwise reach for the conventional solution and you will throw the work away.
- **Write a design brief for big visual changes, and allow deliberate deviation.** — A page describing mood, materials
  and references, plus "override anything that conflicts with the project rules and tell me what you changed",
  produced the best results. Ask for the list of deviations and the reasons.
- **Show screenshots.** — "The floor is white when I look at the door" with a picture gets a root cause (un-occluded
  sun on a glossy floor). The same words without a picture get a guess.
- **Ask for the root cause, not a patch.** — Several stacks of guardrails were deleted once the real fix (streaming, a
  pre-integration baseline, a lock-before-mutate animation) was found. If a fix needs a second and third fix, stop and
  ask what is actually wrong.
- **Keep a project log in the repo.** — After each session, record what changed, why, the numbers, and each lesson as
  a one-line rule. The assistant starts every session with no memory; the log is what stops it repeating an old
  mistake. This guide is that log, cleaned up.
- **Verify before deploying, every time.** — Build, scrub grep, headless render check, targeted assertions, then
  deploy, then check production. Ask the assistant to show the evidence, not report that it "should work".
- **Give feedback in terms of feel.** — "Opens too aggressively", "hurts my eyes", "too cold" are useful; they point
  at easing curves, saturation and colour temperature.
- **Do not let the assistant refactor broadly before a deadline.** — Have it profile and write the plan into the log
  instead.

## Quick reference: numbers

| Thing | Value |
|---|---|
| Eye height (standing / chair / couch) | 1.7 / 1.18 / 1.26 m |
| Max walk speed / sprint | 6.35 / about 11.5 m/s |
| Ground friction / stop speed | 5.2 / 2.0 |
| Ground accelerate / air accelerate | 5.5 / 12 |
| Air wish-speed cap | 0.762 m/s |
| Gravity / jump velocity / apex | 20.32 m/s² / 7.67 m/s / 1.45 m |
| Vertical FOV (90° horizontal at 4:3) | 73.74° |
| Sprint FOV boost | up to +7°, time constant 0.18 s |
| Look smoothing time constant | 0.04 s |
| Step-up height | 0.21 m |
| Stair rise / tread | 0.19 / 0.30 m |
| Stair glue max drop / smoothing decay / clamp | 0.5 m / exp(−13·dt) / ±0.55 m |
| Overhead collider skip / head-bump margin | underside > feet + 1.2 m / eye + 0.15 m |
| Label scale clamp | clamp(distance / 7, 0.3, 1) |
| Interior floor roughness / albedo | ≥ 0.7 / ≤ 0.6 |
| Point-light budget | 14–16 |
| Floor decal canvas density | 400 px/m, max 4096 |
| Anisotropy (text / decorative) | 16 / 4 |
| Shadow map (default / low tier) | 1536 / 1024 |
| Pixel-ratio cap (default / tier 1 / tier 2) | 1.5 / 1.25 / 1.0 |
| Ratchet thresholds | < 48 fps and < 34 fps, sustained 2.5 s |
| State broadcast rate | 10 Hz |
| Chat limit | 6 messages / 10 s |
| Voice gain | full ≤ 2.5 m, silent at 9 m |
| Voice connect / drop | 14 m / 18 m, max 8 peers |
| Helper limits | 30 / min / IP, 400 / day / IP, 2,000 / day global |
