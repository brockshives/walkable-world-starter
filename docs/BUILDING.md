# Building your own world on this kit

A short tour of how the pieces fit, in the order you will touch them. For the reasons behind every rule, see
[LESSONS.md](LESSONS.md).

## The frame loop

`src/main.js` boots everything and runs one loop:

```
controls.update(dt)     player input -> movement -> collision -> camera
world.update(t, pos)    distance culling, sky
mp.update(dt)           send our pose at 10 Hz, ease the other avatars
hotspots.update(...)    label fades, kiosk screens, the [E] prompt
renderer.render(...)
```

`isUiOpen()` in `main.js` is the single answer to "is a menu or text box open?". Movement, hotkeys and the touch
pads all ask it. If you add a panel with a text input, add it to that function, or typing will walk the player.

`window.__world` exposes the camera, controls, world, hotspots and renderer in the browser console. Use it to
teleport (`__world.camera.position.set(x, 1.7, z)`), to count draw calls (`__world.renderer.info.render.calls`), and
in tests.

## Coordinates

Meters. `+X` is east, `-Z` is north, `Y` is up. The player's eye is 1.7 m above their feet and their body is a
circle of radius 0.45 m. A yaw of 0 looks north (`-Z`).

## How collision works

The world keeps a flat list of boxes (`world.colliders`). Three small functions in `src/world.js` do everything:

- `resolveCollisions` pushes the player's circle out of any box that overlaps their body between shin and head.
- `groundHeightAt` returns the highest box top at or just above the feet. That is the floor.
- `ceilingHeightAt` returns the lowest box underside above the head. Jumps stop there.

Consequences you can design with:

- **Stairs** are stacked boxes with risers under 0.2 m. Each step is a solid block from the floor up.
- **Crates and tables** taller than 0.21 m block you until you jump on them.
- **An upper floor** is a slab. Because its underside is above your head, it is a ceiling from below and a floor
  from above, never a wall.
- **Glass** is a collider with `seeThrough: true`: it stops you but does not hide kiosk labels behind it.

Design checks that matter:

- Jump apex is about 1.45 m. `floor top + 1.45 + 1.7` must stay under the ceiling above it.
- Walk every stair up **and** down after you build it. `npm run verify` shows how to automate that.
- Keep the routes between spawn, doors, stairs and kiosks clear of furniture.

## Adding things to the world

Add a builder method to the `World` class and call it from the constructor, before `_flushBoxes()`:

```js
_myRoom() {
  const M = this.M;
  this.plane(8, 6, M.planks, 20, 0.01, -5);                              // floor
  this.box(8, 3, 0.3, M.brick, 20, 1.5, -8.15, { collide: true });       // back wall
  this.box(1.2, 0.9, 0.6, M.crate, 18, 0.45, -6, { collide: true });     // a counter
  const sign = makeSign('MY ROOM', { mw: 4, mh: 0.5 });
  sign.position.set(20, 2.4, -7.97);
  this.group.add(sign);
}
```

`box()` calls made before the flush are merged into one mesh per material, so a room made of hundreds of boxes
costs a handful of draw calls. That is why `box()` returns `null` there: do not keep the result. For something that
moves or needs clicking, create a normal `Mesh` and add it to `this.group` yourself.

New materials go in `_mats()`. New textures are drawn on a canvas in `buildTextures()`; set
`material.userData.tile = [metersU, metersV]` to make a texture tile at a real-world size on every box.

Rules that save the most pain (all explained in LESSONS.md):

- Interior floors: roughness 0.7 or higher, mid-tone or darker. Pale glossy floors blow out to white.
- Lamps are glowing materials, not lights. Keep real `PointLight`s to about a dozen in the whole world.
- A sign's canvas and its plane must have the same aspect ratio (the default is 8:1).
- Things mounted on a wall sit at least 0.03 m off it.

## Adding a kiosk

Add an entry to `HOTSPOTS` in `src/config.js`:

```js
{
  name: 'GUESTBOOK',
  desc: 'Sign the guestbook.',
  url: 'https://example.com/guestbook',
  x: 20, z: -6, ry: 0,        // ry turns the screen; 0 faces south (+Z)
  indoor: true,               // no light beacon indoors
  color: 0x7dffb0,
},
```

Use `menu: { title, sections: [{ title, items: [{ label, url }] }] }` instead of `url` for a list of links. Add
`y: 3.2` to stand it on an upper floor. `type: 'poster'` makes a framed print on a wall instead of a kiosk.

Always check that the screen faces open floor, not a wall or a counter.

## Multiplayer messages

The server (`server.js`) is a relay with rate limits. It holds no world logic.

| Message | Direction | Meaning |
|---|---|---|
| `{t:'p', x, y, z, yaw}` | client to server, 10 Hz | my feet position and facing |
| `{t:'s', p:[[id,x,y,z,yaw,voice],…]}` | server to all, 10 Hz | everyone's state |
| `{t:'n', name}` / `{t:'c', text}` | both | display name / chat line |
| `{t:'vs', on}` / `{t:'rtc', to, d}` | both | voice on/off / WebRTC signaling |
| `{t:'g', r, d}` | both | opaque game packet for room `r`, fanned out to everyone else |

To add a shared mini-game or any shared object, use the `g` channel: let the client with the lowest id be the host,
simulate there, and stream the state with `mp.sendGame(room, data)`. Everyone else renders what `mp.onGame`
receives.

## Performance checklist

- Open the console and read `__world.renderer.info.render.calls`. Draw calls, not triangles, are the limit. Hundreds
  is fine; thousands will drag laptops down.
- Static scenery goes through `box()` so it batches. Small clutter is culled by distance automatically.
- The pixel ratio is capped at 1.5 and steps down by itself on slow machines (`perfCheck` in `main.js`).
- Screens that redraw (kiosk CRTs) are budgeted: a few per tick, only when close.
- After any change to the renderer, shadows or the frame loop, run `npm run verify` and look at the screenshots.

## Before you publish

1. Put every private word (client names, internal hostnames, people) in `scrub-words.txt`.
2. `npm run build && npm run scrub` must report clean. It checks the built bundle too, because method names and
   text drawn on canvases end up in the public JavaScript.
3. `npm run verify` must pass.
4. Secrets (unlock token, any API keys you add) live in your host's secret store, never in the repository.
