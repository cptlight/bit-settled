# Interface design — Apple.ca-inspired system

The interface is intentionally **clean, content-first and high-contrast**, following the visual language of apple.ca: SF-style typography, white space, light-gray product surfaces, thin translucent navigation, one blue action colour and almost no decoration.

## Principles → implementation

| Apple-like principle | What the demo does |
|---|---|
| **Content first** | Large type, short labels, lots of white space; decorative gradients and terminal textures removed. |
| **One obvious action** | Blue pill primary CTA per view: *Run the 5-step demo*, *Auto-configure catalog*, *Start agent negotiation*, *Buy this deal*. |
| **Quiet chrome** | A 48px translucent nav with a hairline divider; no heavy borders or glow. |
| **Product surfaces** | White cards for active work, `#f5f5f7` cards for browsing/secondary sections, 18px radii. |
| **SF type** | `-apple-system`, SF Pro Display/Text fallbacks; headline weight 600 with tight tracking; body neutral gray. |
| **Restrained colour** | Black/near-black text, white surfaces, gray secondary text, and one accent: Apple blue `#0071e3` / link blue `#0066cc`. |
| **Human, not ornamental** | No decorative gold/emerald gradients; colour only communicates action or status. |
| **Accessible** | Contrast-safe text, visible focus rings, responsive layout, `prefers-reduced-motion` support. |

## Tokens

- Canvas: `#ffffff`
- Secondary surface: `#f5f5f7`
- Hairline: `#d2d2d7`
- Text: `#1d1d1f`
- Secondary text: `#6e6e73`
- Accent / primary action: `#0071e3`
- Link: `#0066cc`
- Danger: `#ff3b30`

## Type

```
-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
"Helvetica Neue", Helvetica, Arial, sans-serif
```

Headlines are 600-weight with `letter-spacing: -.025em`; body copy is regular gray; monospace is reserved for IDs, code and API proof.

## Components

- **Buttons:** 980px pill radius; blue filled primary, light-gray secondary; press scale `.98`.
- **Cards:** 18px radius, 1px hairline, no shadow; gray cards for discovery, white cards for work.
- **Nav:** white/80 with backdrop blur, 48px height, 12px links.
- **Inputs:** 12px radius, hairline, blue focus ring.
- **Badges:** small pills; gray/blue, no decorative gold.
- **Code proof:** light `#f5f5f7` panels so the JSON log stays readable but secondary.

## Where it applies

`/start.html`, `/demo.html`, `/merchant.html`, `/market.html`, `/negotiate.html`, `/live.html`, `/board.html`, `/buy.html`, `/agent-connect.html`, `/embed-demo.html`, `/integrate.html`, dashboard, storefront, agent console.
