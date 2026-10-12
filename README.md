# Elemental Type

Elemental Type is a WebGL2 particle engine that builds a word out of a material: rain beading on glass, desert sand, fire, snow, or liquid mercury. You type the word, pick a font, and switch materials. When you switch, the particles morph from one material into the next, sweeping across the word from left to right.

It runs in the browser with plain HTML, CSS and JavaScript. There is no build step and nothing to install.

## Running it

Serve the folder over HTTP and open it in a browser:

```bash
python3 -m http.server 5178
```

Then visit http://localhost:5178. Opening `index.html` straight from disk also works in most browsers, but a local server is more reliable for loading Google Fonts.

The page needs WebGL2 with float render targets (`EXT_color_buffer_float`). Current Chrome, Edge, Firefox and Safari all support this.

## Controls

| Input | What it does |
| --- | --- |
| Material buttons or keys `1` to `5` | Switch between Water, Sand, Fire, Snow and Mercury |
| Word field | Type any word; the particles flow into the new shape |
| Fonts menu | Choose a system font or a Google Font, search the list, or type the name of any Google Font to load it |
| Shuffle button | Pick a random font |
| Replay button or `R` | Play the current material's entrance again |
| Arrow tab above the panel | Collapse the panel to a small pill showing the current material; click the pill to expand it again. The page remembers the choice |
| `H` | Hide or show the control panel |
| Mouse | Hover or drag through the letters to disturb them |

Each material has a signature word (Water, Desert, Fire, Snow, Mercury). Switching materials swaps in the new signature word unless you have typed your own.

The word is sized from the pixels the font actually draws, with a margin on each side, so wide words, italics and swash letters stay on screen.

## The materials

Water drops rain onto the letters and bead into a glassy surface that refracts the background. Rain that hits the top edges of the letters splashes off in small droplets, and drops collect and fall from the bottom edges. Hovering knocks water off the word; it falls away and the gap refills with rain from above.

Sand is carried in on the wind from the left and builds the word letter by letter. Hovering loosens grains, which drift off to the right in gusts and then blow back in from the left to settle into place. Dust blows across the screen the whole time.

A sixth material, Gel, is still in the engine but hidden from the picker. It drops in with a jelly wobble, sags into slow drips along the bottom edges, and smears like thick goo under the cursor. To bring it back, remove `hidden: true` from its entry in `MATS`.

Fire has a glowing core with flames rising off the tops of the letters and embers floating upward. Moving the cursor through it fans the flames: the fire gets hotter, more flames catch, and they lean in the direction you move.

Snow drifts down and settles into the letters, while wind lifts flakes off the top edges.

Mercury pools at the bottom of the screen and pulls itself up into the word. It renders as liquid chrome with a reflected horizon line across the letters.

## How it works

Everything lives in `main.js`.

1. Text sampling. The word is drawn to an offscreen canvas. A target point for each particle is picked at random from the filled pixels, along with that point's distance to the top and bottom edges of the glyph. The edge distances drive the effects that only happen at the rims, such as splashes, drips, flames and wind erosion.
2. Simulation. The CPU updates every particle each frame using typed arrays. Each particle has a small state (arriving, settled, loose, splashing) and its forces depend on the material it currently belongs to. The integrator is semi-implicit Euler with implicit damping, which keeps the stiff springs stable.
3. Particle pass. Particles are drawn as instanced quads, stretched along their velocity so fast drops become streaks. They are blended additively into two half-float render targets at once. The first holds weighted colour and density; the second holds weighted material properties (how liquid, how glowing, how opaque, how metallic).
4. Composite pass. A full-screen shader reads both targets and mixes three looks per pixel: opaque grains, additive glow, and a liquid surface. The liquid surface thresholds the density field (metaballs) and lights it with normals from the density gradient, adding refraction, specular highlights and, for mercury, a chrome environment.

When you switch materials, each particle gets its own delay based on its horizontal position. Its colour, size, shape and physics change once that delay passes. Because the composite pass blends looks per pixel, sand can melt into mercury or fire can cool into water partway across the word.

The particle count scales with the window size, from 14,000 to 42,000.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Page markup and the control panel |
| `style.css` | Panel, font menu and layout styles, including the phone layout |
| `main.js` | Material definitions, shaders, simulation, rendering, font loading and UI |

## Customising

Materials are defined in the `MATS` array at the top of `main.js`. Each one sets its particle size, softness, velocity streaking, how liquid, glowing or metallic it looks, a three-colour palette, background colours, and how strongly the cursor affects it. Each material's movement is coded in its own `case` in `update()`. A material with `hidden: true` stays in the engine but is left out of the picker and the number keys.

The font menu lists `SYSTEM_FONTS` and `FONTS`, both near the top of `main.js`. Add a Google Font family name to `FONTS` to include it in the menu. Any other Google Font can still be loaded by typing its name in the menu's search box.
