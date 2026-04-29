# PhillyEdge Design System

> Reference document for developers. Every value below is taken directly from the codebase — no guesses.

---

## 1. Color Palette

The palette is **Tailwind's `slate` scale** for chrome/surfaces, plus **`sky`** as the primary brand accent and semantic signal colors. All hex values are the Tailwind v3/v4 defaults.

### Background colors

| Role | Tailwind token | Hex |
|---|---|---|
| Page background | `slate-900` / `--background` | `#0f172a` |
| Card / panel surface | `slate-800` | `#1e293b` |
| Elevated surface (inputs, buttons) | `slate-700` | `#334155` |
| Subtle tinted surface | `slate-700/40–50` | `#33415566–80` |
| Scrollbar track | `slate-800` | `#1e293b` |
| Nav bar | `slate-900/80` (80 % opacity + blur) | `#0f172acc` |
| Modal overlay | `black/60` | `#00000099` |

### Text colors

| Role | Tailwind token | Hex |
|---|---|---|
| Primary text / headings | `white` | `#ffffff` |
| Body text | `slate-200` / `--foreground` | `#e2e8f0` |
| Secondary text | `slate-300` | `#cbd5e1` |
| Subdued / label text | `slate-400` | `#94a3b8` |
| Muted / meta text | `slate-500` | `#64748b` |
| Placeholder | `slate-600` | `#475569` |

### Accent / brand

| Role | Tailwind token | Hex |
|---|---|---|
| Primary brand | `sky-500` | `#0ea5e9` |
| Brand hover | `sky-400` | `#38bdf8` |
| Focus ring | `sky-500` | `#0ea5e9` |
| Links | `sky-400` | `#38bdf8` |

### Signal / semantic colors

| Signal | Background | Text | Border | Hex (text) |
|---|---|---|---|---|
| Strong Buy | `emerald-500/20` | `emerald-400` | `emerald-500/30` | `#34d399` |
| Buy | `sky-500/20` | `sky-400` | `sky-500/30` | `#38bdf8` |
| Neutral | `slate-500/20` | `slate-400` | `slate-500/30` | `#94a3b8` |
| Avoid | `red-500/20` | `red-400` | `red-500/30` | `#f87171` |

### Order status colors

| Status | Background | Text | Border |
|---|---|---|---|
| 🟡 Resting | `yellow-500/15` | `yellow-300` | `yellow-500/30` |
| 🟠 Partial Fill | `orange-500/15` | `orange-300` | `orange-500/30` |
| 🟢 Filled | `emerald-500/15` | `emerald-300` | `emerald-500/30` |
| 🔴 Cancelled | `red-500/15` | `red-300` | `red-500/30` |
| ⚫ Expired | `slate-500/20` | `slate-400` | `slate-500/30` |

### State / feedback colors

| Role | Tailwind token | Hex |
|---|---|---|
| Positive / win / success | `emerald-400` | `#34d399` |
| Success button bg | `emerald-600` | `#059669` |
| Negative / loss / error | `red-400` | `#f87171` |
| Error button/border | `red-500` | `#ef4444` |
| Warning / demo mode | `amber-400` | `#fbbf24` |
| Warning badge bg | `amber-500/10–20` | — |
| Hedge indicator | `amber-500/20` | `amber-400` | `#f59e0b` |
| No-cover indicator | `purple-500/20` | `purple-400` | `#c084fc` |
| Hot temperature | `orange-400` | `#fb923c` |
| Very hot temperature | `red-400` | `#f87171` |
| Cold temperature | `sky-300` | `#7dd3fc` |

### Border colors

| Role | Tailwind token | Hex |
|---|---|---|
| Card border | `slate-700` | `#334155` |
| Input border | `slate-600` | `#475569` |
| Divider / table row | `slate-700/50` | `#33415580` |
| Section divider | `slate-700` | `#334155` |
| Scrollbar thumb | `slate-500` | `#64748b` |
| Focus-ring color | `sky-500` | `#0ea5e9` |

---

## 2. Typography

### Font families

```css
/* globals.css — body default */
font-family: ui-sans-serif, system-ui, sans-serif;

/* Next.js layout — loaded via next/font/google */
--font-geist-sans   /* Geist Sans — all UI text */
--font-geist-mono   /* Geist Mono — monospace (order IDs, code) */
```

Applied in `<html>` as CSS variables:
```html
<html class="font-[--font-geist-sans]">
```

### Type scale

| Role | Tailwind classes | Approx size | Weight |
|---|---|---|---|
| Page heading | `text-2xl font-bold text-white` | 24px | 700 |
| Modal heading | `text-lg font-bold text-white` | 18px | 700 |
| Card title | `text-base font-semibold text-white` | 16px | 600 |
| Body / row text | `text-sm text-slate-200` | 14px | 400 |
| Button label | `text-sm font-semibold` or `font-medium` | 14px | 600 / 500 |
| Section header | `text-xs font-semibold text-slate-400 uppercase tracking-wide` | 12px | 600 |
| Table header | `text-xs text-slate-500 uppercase tracking-wider` | 12px | 400 |
| Label | `text-xs text-slate-500` | 12px | 400 |
| Caption / meta | `text-xs text-slate-400` | 12px | 400 |
| Monospace (IDs) | `text-xs font-mono text-slate-500` | 12px | 400 |
| Large stat | `text-2xl font-bold` | 24px | 700 |
| Hero emoji | `text-4xl` or `text-5xl` | 36–48px | — |

### Letter spacing

| Context | Class | Value |
|---|---|---|
| Section headers, table headers | `tracking-wide` | `0.025em` |
| Table headers (wider) | `tracking-wider` | `0.05em` |
| Brand logo | `tracking-tight` | `-0.025em` |

---

## 3. Component Patterns

### Cards

```html
<!-- Standard card -->
<div class="bg-slate-800 border border-slate-700 rounded-xl p-5">

<!-- Summary stat card (tighter padding) -->
<div class="bg-slate-800 border border-slate-700 rounded-xl p-4">

<!-- Inset stats panel (no border, semi-transparent) -->
<div class="bg-slate-700/50 rounded-xl p-4">

<!-- Tinted leg/section card -->
<div class="bg-slate-700/40 border border-slate-600 rounded-xl p-3">

<!-- Forecast day card (with focus and status border variants) -->
<div class="bg-slate-800 border border-slate-700 rounded-xl p-3 focus-within:border-sky-600">
<!-- error state: border-red-500/60 -->
<!-- saved state: border-emerald-600/40 -->

<!-- Modal container -->
<div class="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
```

### Buttons

```html
<!-- Primary (sky) -->
<button class="bg-sky-500 hover:bg-sky-400 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors">

<!-- Primary large (modal footer) -->
<button class="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-white text-sm font-semibold transition-colors">

<!-- Primary with glow (sticky CTA) -->
<a class="bg-sky-500 hover:bg-sky-400 text-white font-semibold px-5 py-3 rounded-xl shadow-xl shadow-sky-500/20 transition-colors text-sm">

<!-- Secondary (outlined) -->
<button class="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors">

<!-- Ghost (toolbar/utility) -->
<button class="text-sm px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">

<!-- Success (post-trade) -->
<button class="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors">

<!-- Danger (destructive text link) -->
<button class="text-xs text-red-400 hover:text-red-300 transition-colors">

<!-- Disabled modifier (appended to any button) -->
disabled:bg-slate-600 disabled:cursor-not-allowed
```

### Badges / Pills

```html
<!-- Signal badge (square corners) -->
<span class="inline-block px-2 py-0.5 rounded text-xs font-semibold
             bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
  Strong Buy
</span>

<!-- Order status badge (pill shape) -->
<span class="text-xs font-semibold px-2 py-0.5 rounded-full border
             bg-yellow-500/15 text-yellow-300 border-yellow-500/30">
  🟡 Resting
</span>

<!-- Demo mode badge (amber pill) -->
<span class="text-xs font-bold px-2 py-0.5 rounded-full
             bg-amber-500/20 text-amber-400 border border-amber-500/30">
  DEMO
</span>

<!-- Inline data tag (dark chip) -->
<span class="text-xs text-slate-400 bg-slate-700 px-2 py-0.5 rounded">
  Edge: +12pts
</span>

<!-- Position builder reason tag -->
<!-- Primary:  bg-sky-500/20  text-sky-400  border-sky-500/30  -->
<!-- Hedge:    bg-amber-500/20 text-amber-400 border-amber-500/30 -->
<!-- NO cover: bg-purple-500/20 text-purple-400 border-purple-500/30 -->
<span class="text-xs px-1.5 py-0.5 rounded border font-semibold [color classes above]">
```

### Filter / Tab Pills (horizontal bar)

```html
<!-- Active -->
<button class="px-4 py-1.5 rounded-full text-sm font-medium border
               bg-sky-500 border-sky-500 text-white">

<!-- Inactive -->
<button class="px-4 py-1.5 rounded-full text-sm font-medium border
               border-slate-600 text-slate-400
               hover:text-slate-200 hover:border-slate-500">
```

### Nav Tabs

```html
<!-- Active nav tab -->
<a class="px-4 py-1.5 rounded-md text-sm font-medium bg-slate-700 text-white">

<!-- Inactive nav tab -->
<a class="px-4 py-1.5 rounded-md text-sm font-medium
          text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
```

### Input Fields

```html
<!-- Standard input -->
<input class="w-full bg-slate-700 border border-slate-600 rounded-lg
              px-3 py-2 text-white text-sm
              focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent
              placeholder:text-slate-600">

<!-- Input with prefix symbol ($) -->
<div class="relative">
  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
  <input class="w-full bg-slate-700 border border-slate-600 rounded-lg
                pl-7 pr-16 py-2 text-white text-sm
                focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent">
  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">USDC</span>
</div>

<!-- Small input (forecast cards) -->
<input class="w-full bg-slate-700 border border-slate-600 rounded-md
              px-2 py-1 text-sm text-center
              focus:outline-none focus:ring-1 focus:ring-sky-500
              placeholder:text-slate-600">

<!-- Select -->
<select class="bg-slate-700 border border-slate-600 rounded-lg
               px-2 py-1 text-sm text-white
               focus:outline-none focus:ring-2 focus:ring-sky-500
               disabled:opacity-50">

<!-- Range slider -->
<input type="range" class="flex-1 accent-sky-500 disabled:opacity-40">

<!-- Checkbox -->
<input type="checkbox" class="accent-sky-500 shrink-0">

<!-- Label pattern -->
<label class="block text-sm font-medium text-slate-300 mb-2">Label</label>
<!-- or smaller: -->
<label class="block text-xs text-slate-500 mb-1">Label</label>
```

### Tables

```html
<table class="w-full text-sm">
  <thead>
    <tr class="text-left text-xs text-slate-500 uppercase tracking-wider
               border-b border-slate-700">
      <th class="pb-3 pr-4">Column</th>
    </tr>
  </thead>
  <tbody class="divide-y divide-slate-700/50">
    <tr class="hover:bg-slate-800/50 transition-colors">
      <td class="py-3 pr-4 text-slate-200">Value</td>
    </tr>
  </tbody>
</table>
```

### Modals

```html
<!-- Overlay -->
<div class="fixed inset-0 bg-black/60 backdrop-blur-sm
            flex items-center justify-center z-50 p-4">
  <!-- Container -->
  <div class="bg-slate-800 border border-slate-700 rounded-2xl
              w-full max-w-md shadow-2xl"
       onclick="stopPropagation">

    <!-- Header -->
    <div class="p-6 border-b border-slate-700">...</div>

    <!-- Scrollable body -->
    <div class="p-6 space-y-5">...</div>

    <!-- Footer -->
    <div class="p-6 pt-0 flex gap-3">
      <!-- Cancel + Confirm buttons -->
    </div>

  </div>
</div>

<!-- Tall modal (position builder) — scrollable body -->
<div class="flex flex-col max-h-[90vh]">
  <div class="px-6 py-4 border-b border-slate-700 shrink-0"><!-- header --></div>
  <div class="overflow-y-auto flex-1 px-6 py-4 space-y-5"><!-- body --></div>
  <div class="px-6 py-4 border-t border-slate-700 shrink-0 flex gap-3"><!-- footer --></div>
</div>
```

### Toast Notifications

```html
<!-- Container (fixed, bottom-right) -->
<div class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">

  <!-- Fill toast -->
  <div class="pointer-events-auto px-4 py-3 rounded-xl shadow-xl text-sm font-medium
              border backdrop-blur-sm cursor-pointer
              bg-emerald-900/90 border-emerald-500/40 text-emerald-200">

  <!-- Cancel toast -->
  <div class="... bg-slate-800/90 border-slate-600/40 text-slate-300">

  <!-- Error toast -->
  <div class="... bg-red-900/90 border-red-500/40 text-red-200">
```

### Error / Info Banners

```html
<!-- Error inline -->
<div class="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">

<!-- Warning/info (amber) -->
<div class="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-400 text-sm font-semibold text-center">

<!-- Demo mode banner (full-width sticky) -->
<div class="bg-amber-400 text-amber-950 text-center text-sm font-bold py-2 px-4 sticky top-14 z-40">
```

### Navigation Bar

```html
<header class="border-b border-slate-700 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
  <div class="max-w-6xl mx-auto px-4 flex items-center gap-8 h-14">
    <!-- Logo -->
    <a class="font-bold text-lg text-sky-400 tracking-tight shrink-0">PhillyEdge</a>
    <!-- Tabs -->
    <nav class="flex gap-1">...</nav>
    <!-- Right meta text -->
    <span class="ml-auto text-xs text-slate-500 hidden sm:block">...</span>
  </div>
</header>
```

---

## 4. Spacing & Layout

### Page layout

```html
<!-- Root page wrapper -->
<main class="max-w-6xl mx-auto px-4 py-8">

<!-- Standard content stack -->
<div class="space-y-6">

<!-- Section stack (within a page) -->
<div class="space-y-4">

<!-- Tight stack (within a card) -->
<div class="space-y-2">
```

### Border radius

| Token | Value | Usage |
|---|---|---|
| `rounded` | 4px | Signal badges (square) |
| `rounded-md` | 6px | Small inputs, small selects |
| `rounded-lg` | 8px | Standard inputs, small cards, inline chips |
| `rounded-xl` | 12px | Cards, buttons, modals |
| `rounded-2xl` | 16px | Large modals |
| `rounded-full` | 9999px | Filter pills, status badges |

### Shadows

| Token | Usage |
|---|---|
| `shadow-2xl` | Modal containers |
| `shadow-xl shadow-sky-500/20` | Floating CTA buttons (glowing brand shadow) |

### Common gap / padding patterns

| Context | Classes |
|---|---|
| Card padding (standard) | `p-5` (20px) |
| Card padding (compact) | `p-4` (16px) |
| Card padding (modal section) | `p-6` (24px) |
| Button horizontal padding | `px-4` (16px) or `px-5` (20px) |
| Button vertical padding | `py-2` (8px) or `py-2.5` (10px) |
| Grid gap (stat cards) | `gap-4` (16px) |
| Flex gap (button row) | `gap-3` (12px) |
| Flex gap (nav tabs) | `gap-1` (4px) |
| Flex gap (badge row) | `gap-2` (8px) |
| Table cell right padding | `pr-4` (16px) |
| Table cell vertical padding | `py-3` (12px) |

### Responsive breakpoints used

| Breakpoint | Usage |
|---|---|
| `sm:` (640px) | 2-col → 4-col stat grid; show nav subtitle |
| Default (mobile) | Single column, full-width cards |

---

## 5. CSS Variables & Globals

### `app/globals.css` (complete file)

```css
@import "tailwindcss";

:root {
  --background: #0f172a;  /* slate-900 */
  --foreground: #e2e8f0;  /* slate-200 */
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: ui-sans-serif, system-ui, sans-serif;
}

/* Custom dark scrollbar */
::-webkit-scrollbar       { width: 6px; }
::-webkit-scrollbar-track { background: #1e293b; }      /* slate-800 */
::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; } /* slate-500 */
```

### `app/layout.tsx` font setup

```tsx
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Applied to <html>:
className={`${geistSans.variable} ${geistMono.variable} dark`}
```

### Tailwind v4 config

This app uses **Tailwind v4** with the CSS-first `@import "tailwindcss"` approach — there is no `tailwind.config.js`. All customization lives in `globals.css` under `@theme inline`. The `dark` class is hardcoded on `<html>` (always dark mode).

---

## 6. Opacity Scale for Colors

A consistent opacity shorthand is used throughout for translucent overlays:

| Suffix | Value | Typical use |
|---|---|---|
| `/10` | 10% | Very subtle tinted backgrounds (error, warning banners) |
| `/15` | 15% | Order status badge backgrounds |
| `/20` | 20% | Signal badge backgrounds, colored button variants |
| `/30` | 30% | Badge borders, divider borders |
| `/40` | 40% | Card borders in subdued states |
| `/50` | 50% | Table row dividers, inset panel backgrounds |
| `/60` | 60% | Modal overlay (`black/60`) |
| `/80` | 80% | Nav bar background (`slate-900/80`) |
| `/90` | 90% | Toast backgrounds (`emerald-900/90`, etc.) |

---

## 7. Interaction Patterns

### Focus states
All interactive elements use `focus:outline-none focus:ring-2 focus:ring-sky-500` (or `focus:ring-1` for compact inputs). `focus:border-transparent` removes the default border on focus for full-width inputs.

### Hover states
- Buttons: lighten one step (`sky-500` → `sky-400`, `slate-700` → `slate-600`)
- Links / table rows: `hover:text-sky-400`, `hover:bg-slate-800/50`
- Border elements: `hover:border-slate-500`

### Transitions
All interactive elements use `transition-colors` (color/border transitions only, no layout shift).

### Disabled states
```
disabled:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50
```

### Loading / pending states
- Buttons: text changes to "Placing…" / "Refreshing…" with `disabled` applied
- Save indicators: `animate-pulse text-sky-400` for in-progress dots
