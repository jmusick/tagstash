---
name: Tagstash
description: A tag-first bookmark manager; a calm tool for saving, sorting and finding links.
colors:
  stash-violet: "#6d45ff"
  stash-violet-hover: "#7b57ff"
  stash-violet-bright: "#a48fff"
  stash-violet-wash: "rgba(109, 69, 255, 0.16)"
  link-lilac: "#b3a3ff"
  tag-stock: "#33295a"
  tag-stock-hover: "#3d3170"
  tag-stock-edge: "#4a3d85"
  tag-ink: "#d4c8ff"
  tag-ink-muted: "#b3a8e0"
  favorite-marigold: "#f0b13a"
  favorite-marigold-wash: "rgba(240, 177, 58, 0.15)"
  graphite-ground: "#1b1a20"
  graphite-surface: "#23222a"
  graphite-panel: "#222128"
  graphite-panel-raised: "#2a2932"
  hairline: "rgba(255, 255, 255, 0.08)"
  hairline-strong: "rgba(255, 255, 255, 0.17)"
  field-edge: "#7b7983"
  ink: "#f2f1f5"
  ink-soft: "rgba(242, 241, 245, 0.78)"
  ink-muted: "rgba(242, 241, 245, 0.56)"
  success-mint: "#6fd6a4"
  success-solid: "#15803d"
  danger-rose: "#ff8f9e"
  danger-solid: "#c0284a"
  danger-solid-hover: "#a82147"
typography:
  display:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.25rem, 4.8vw, 3.75rem)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.625rem, 2.5vw, 2rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  page-title:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.625rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  lede:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.55
  row-title:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1
  meta:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'tnum' 1"
  micro:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
  code:
    fontFamily: "ui-monospace, 'Cascadia Mono', 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.9em"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "7px"
  md: "8px"
  field: "10px"
  card: "12px"
  panel: "14px"
  pill: "999px"
spacing:
  hairline: "0.2rem"
  tight: "0.4rem"
  snug: "0.7rem"
  row: "0.95rem 1.1rem 1.05rem"
  panel: "1.1rem"
  section: "1.5rem"
  gutter: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.stash-violet}"
    textColor: "#ffffff"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.stash-violet-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.25rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.md}"
    padding: "0 0.8rem"
    height: "2.85rem"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.sm}"
    size: "2rem"
  button-danger:
    backgroundColor: "{colors.danger-solid}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.25rem"
  button-danger-hover:
    backgroundColor: "{colors.danger-solid-hover}"
  search-field:
    backgroundColor: "{colors.graphite-panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    borderColor: "{colors.field-edge}"
    height: "2.85rem"
    padding: "0 0.45rem 0 0.9rem"
  input-field:
    backgroundColor: "rgba(255, 255, 255, 0.045)"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    borderColor: "{colors.field-edge}"
    padding: "0.75rem"
  panel:
    backgroundColor: "{colors.graphite-panel}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  bookmark-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    padding: "{spacing.row}"
  bookmark-row-editing:
    backgroundColor: "{colors.graphite-panel-raised}"
  tag:
    backgroundColor: "{colors.tag-stock}"
    textColor: "{colors.tag-ink}"
    typography: "{typography.label}"
    height: "1.9em"
    padding: "0 0.7em 0 1.05em"
  tag-hover:
    backgroundColor: "{colors.tag-stock-hover}"
  tag-active:
    backgroundColor: "{colors.stash-violet}"
    textColor: "#ffffff"
  filter-chip:
    backgroundColor: "{colors.stash-violet-wash}"
    textColor: "{colors.stash-violet-bright}"
    rounded: "{rounded.pill}"
    padding: "0.2rem 0.6rem"
  favorite-toggle-active:
    backgroundColor: "{colors.favorite-marigold-wash}"
    textColor: "{colors.favorite-marigold}"
    rounded: "{rounded.sm}"
    size: "2rem"
---

# Design System: Tagstash

## Overview

**Creative North Star: "The Quiet Workbench"**

Tagstash is a tool surface for sorting and finding, and it looks like one. The interface is a tidy bench: a graphite ground, a few bordered panels laid on it, and the user's links in a single ordered index. Nothing on the bench competes with the work. Color is held back for the things the user acts on (the main action, the selected tag, the focused field) so the library itself reads first.

Components are calm and exact. Surfaces are flat and edged with hairline borders rather than lifted with shadows; state shows through color, border and a soft focus halo, never through movement. A bookmark row doesn't shift, scale or lift on hover; its actions simply appear. The one piece of identity allowed to show is the tag itself: a violet shipping tag with a pointed end and a punched eyelet, taken from the logo, used everywhere a tag appears.

The system ships in three themes that share one structure: **Slate** (neutral graphite, the default and the values in the frontmatter), **Midnight** (deep indigo, the original purple-leaning dark theme) and **Light** (cool paper). Every themed value is a CSS custom property in `src/index.css`; components never hardcode a theme-sensitive color. Playful or cartoon styling is ruled out: no mascots, illustrations or bouncy motion.

**Key Characteristics:**
- Utility before identity; the library is the hero.
- Flat, hairline-bordered panels on a quiet ground.
- One saturated accent, Stash Violet, reserved for action and selection.
- The shipping-tag shape is the signature and appears wherever a tag does.
- One typeface (Public Sans) on one role scale: plain, open and legible at the small sizes a library lives at.
- Three themes, one structure, all values through variables.

## Colors

One saturated violet over quiet graphite (or indigo, or cool paper), with marigold kept for favorites and mint and rose kept for status.

### Primary
- **Stash Violet** (#6d45ff; #5a2ff0 in Light): the one accent. Primary buttons, the selected (active) tag, the left edge of a row being edited, progress fills, and the selected segment of toggles. Its brighter tone, **Stash Violet Bright** (#a48fff; #ab98ff in Midnight, #4a22d6 in Light), carries focus outlines, focused field borders, the active theme icon and filter-chip text. **Stash Violet Wash** tints filter chips and selected backgrounds.
- **Link Lilac** (#b3a3ff; #b9aaff in Midnight, #5a2ff0 in Light): bookmark titles on hover and in-copy links. Titles rest in full ink and only turn lilac with an underline when pointed at.

### Secondary
- **Tag Stock** (#33295a): the soft violet fill of every unselected tag, with **Tag Ink** (#d4c8ff) text and a one-pixel **Tag Stock Edge** (#4a3d85) underline drawn as a drop shadow. Midnight uses #2d236b / #d8cdff / #4334a0; Light uses #ebe6fd / #4320c9 / #cfc3fa. The fill must be opaque because the pointed end is a separate shape. Counts on a tag use **Tag Ink Muted** (#b3a8e0; #b4a8ea in Midnight, #5a3fc4 in Light; 90% white on a selected tag), which clears 4.5:1 on the fill.

### Tertiary
- **Favorite Marigold** (#f0b13a; #f3b843 in Midnight, #b97c06 in Light): favorites only, meaning the star on a row, the favorite-tag star and the Favorites filter, on a **Marigold Wash** when active. It never appears as decoration.

### Neutral
- **Graphite Ground** (#1b1a20): the page background in Slate. Midnight: #11102a. Light: #f1f1f5.
- **Graphite Panel** (#222128) and **Graphite Surface** (#23222a): the bordered panels (bookmark index, tag rack, filter blocks) and form surfaces. Light: #ffffff.
- **Graphite Panel Raised** (#2a2932): the row being edited and other "lifted by tone" surfaces.
- **Hairline** (8% white) and **Hairline Strong** (17% white): panel borders and row dividers, then secondary-button borders. Light uses 10% / 20% of ink #1c1830.
- **Field Edge** (#7b7983; #7570ae in Midnight, #83808f in Light): the outline of every search, text, select and textarea field. It is opaque and strong enough to clear 3:1 (WCAG 1.4.11) against the field and whatever surface it sits on, so control boundaries stay visible without thickening panel hairlines.
- **Ink** (#f2f1f5; #efedff in Midnight, #1c1830 in Light): headings and titles. **Ink Soft** (78%) is body copy and descriptions. **Ink Muted** (56% in the dark themes, 66% in Light so it clears 4.5:1) is meta text, counts, hints and resting icons.

### Status
- **Success Mint** (#6fd6a4; #0d704a in Light) and **Danger Rose** (#ff8f9e; #b0244b in Light) are text tones over their 13% washes in banners. White text sits only on the solid fills: **Success Solid** (#15803d), **Danger Solid** (#c0284a) and its hover (#a82147), which are the same in every theme.

### Named Rules
**The One Accent Rule.** Stash Violet is the only saturated color in the chrome. It marks what the user can do next or what is currently selected; it never fills a panel, a header or a background.

**The Variables-Only Rule.** Every theme-sensitive color comes from a `--color-*`, `--shadow-*` or `--theme-gradient` variable. A hex value in component CSS is a bug in two of the three themes.

**The Real Contrast Rule.** Text is dimmed with a color variable, never `opacity`, so its contrast stays checkable. Text must clear 4.5:1 on its real background in all three themes.

## Typography

**Font:** Public Sans, self-hosted variable (wght 400 to 800), with a metric-matched Arial fallback (`Public Sans Fallback`) and then system-ui, -apple-system, Segoe UI, sans-serif.
**Code:** the platform monospace (`--font-mono`: ui-monospace, Cascadia Mono, SF Mono, Menlo, Consolas), at 0.9em of the surrounding text, for API keys, IDs and code samples only.

**Character:** One plain, open grotesque doing every job. Public Sans has wide apertures and even spacing, so dates, domains and 13px tags stay readable on the dark themes, and its matter-of-fact voice suits copy that states exact limits. Hierarchy comes from size steps and weight (800 display, 700 headings, 600 titles and labels, 400 text), not from a second family or a width axis.

### Hierarchy
Every size is a role token in `src/index.css` (`--text-*`); components use the token, never a literal.
- **Display** (`--text-display`, 800, clamp(2.25rem, 4.8vw, 3.75rem), 1.05, -0.03em): public page heroes (homepage, Features, Developers), capped at about 18ch.
- **Headline** (`--text-headline`, 700, clamp(1.625rem, 2.5vw, 2rem), 1.2, -0.02em): section headings on every public page.
- **Page Title** (`--text-page-title`, 700, 1.625rem): page titles in the app (Settings, Trash, Duplicates, Privacy, Support, public profiles) and the auth card.
- **Title** (`--text-title`, 700, 1.25rem): panel and section headings in the app, such as "Tags" on the rack.
- **Lede** (`--text-lede`, 400, 1.125rem, 1.55): intro paragraphs and subtitles.
- **Row Title** (`--text-row-title`, 600, 1.0625rem, 1.3): bookmark titles, card and FAQ headings. Bookmark titles break anywhere rather than overflow.
- **Body** (`--text-body`, 400, 1rem, 1.5): default copy, inputs and search.
- **UI** (`--text-ui`, 0.9375rem): buttons (600 primary, 500 ghost), nav links (500), form labels, bookmark descriptions (max 75ch) and helper copy.
- **Label** (`--text-sm`, 600, 0.875rem, line-height 1): tags, chips, filter labels, pagination and secondary controls.
- **Meta** (`--text-meta`, 400, 0.8125rem, tabular figures): dates, counts, domains, hints, footer. Tags inside bookmark rows also use this size; it is the floor for tag labels.
- **Micro** (`--text-xs`, 0.75rem): tooltips and tiny badges only.

Three sizes are deliberately outside the role scale: the rack's usage scale (`.tag-size-1` to `-5`: 13, 14, 16, 18 and 20px, a data encoding that tops out at the Title size), the pricing figure (2.75rem) and the dialog close glyph.

### Named Rules
**The One Scale Rule.** A size comes from a `--text-*` role, so a repeated role is identical on every screen. A new size means a new role with a job no existing role does, added to `src/index.css` and here, never a one-off literal a hair away from an existing step.

**The Tabular Count Rule.** Public Sans's default figures are proportional, which suits prose. Counts, dates, pagination, usage meters and version numbers switch to tabular figures so columns of numbers don't jitter.

## Layout

The app is a centered page up to 1440px wide with 1.5rem / 2rem padding. Under a header row (logo, primary nav, theme selector, account) sits a two-column grid: the main column takes 2fr and the sidebar takes 1fr with a 300px minimum, separated by a 2rem gap. The main column holds the toolbar (search first, then Select / Random / Refresh and the primary "Add bookmark"), the compact plan meter and the bookmark index. The meter is one line with a thin bar; its details expand at 80% of the free limit or on request, with upgrade options only when paid plans are available. The sidebar holds filter blocks (Domain, Month saved, Show only) and the tag rack, and stays sticky 1.5rem from the top.

Search is the primary control. Below 1280px, secondary toolbar buttons drop their text labels before the search field gets squeezed. At 1024px and below, the grid collapses to one column (sidebar after the list, no longer sticky), page padding tightens to 1rem, the logo shrinks and the nav moves into a menu toggle. At 640px rows, the trash and the consent banner restack.

Density is moderate: rows use 0.95rem / 1.1rem padding, and panels use 1.1rem. Description and meta lines are indented to line up under the title, past the 18px favicon. Spacing comes in rem steps (0.2, 0.4, 0.7, 0.85, 1.1, 1.5, 2rem) rather than a strict 4/8 grid.

## Elevation & Depth

The system is flat at rest. Depth comes from tone and hairlines: a darker ground, a slightly lighter panel, a 1px border, and a still lighter raised tone for the row being edited. The three shadow tokens are reserved for things that float over the page: menus, popovers, the auth card and dialogs. Each theme defines its own shadow values, much softer in Light.

### Shadow Vocabulary
- **Shadow Small** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3)`): small floating controls.
- **Shadow Medium** (`box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34)`): the auth card and popovers.
- **Shadow Large** (`box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45)`): menus and dialogs over the overlay (72% ink-black; 20% in Light).
- **Focus Halo** (`box-shadow: 0 0 0 3px rgba(var(--color-accent-rgb), 0.18)` plus a Stash Violet Bright border): focused search and form fields. Everything else focuses with a 3px Stash Violet Bright outline offset 3px.

### Named Rules
**The Flat Bench Rule.** Panels and rows never cast shadows. A shadow means "this is floating above the page"; if it isn't floating, use a border or a tone.

**The Still Row Rule.** Rows and cards don't move on hover: no lift, no scale, no shift. Hover reveals actions and changes color only.

## Shapes

Corners are gently rounded and grow with the size of the container: 4px on favicons, 7px on icon buttons, 8px on buttons and inputs, 10px on the search field, 12px on small cards, and 14px on the main panels (the bookmark index and the tag rack). Segmented controls, filter chips and the theme selector are full pills (999px). Borders are always 1px hairlines. Features asides and expanded bookmark notes use a full neutral border rather than a decorative accent stripe; Markdown blockquotes keep their left border to identify quoted text.

The one non-rectangular form is the tag: a pill-height label (1.9em) with a square left side, 0.3em rounded right corners, a 0.6em triangular point clipped onto the left, and a punched eyelet painted as a radial gradient in the color of the surface beneath (`--tag-eyelet`, the panel color by default).

## Components

### Buttons
Calm and exact; color changes, nothing moves.
- **Shape:** gently rounded (8px), with an inline icon and label 0.45rem apart.
- **Primary:** Stash Violet fill, white 600 text at the UI size (0.9375rem), 0.7rem × 1.25rem padding. Hover steps to Stash Violet Hover. Disabled drops to 50% opacity with a not-allowed cursor. One per view.
- **Secondary:** transparent with a Hairline Strong border and Ink text (500). Hover adds a faint surface wash and turns the border Stash Violet Bright. Disabled keeps full opacity but drops to Ink Muted text and a Hairline border, so it still reads as present.
- **Ghost:** borderless, Ink Soft text, 2.85rem tall to sit level with the search field; hover adds the surface wash and full Ink. Used for toolbar actions (Select, Random, Refresh) and nav.
- **Icon:** 2rem square, 7px corners, Ink Muted at rest. Row actions (open, edit, favorite, private, delete) fade in on row hover or focus on pointer devices, stay visible while a row is edited or an action is active, and are always shown on touch. The favorite action turns marigold on a Marigold Wash.
- **Danger:** Danger Solid fill with white text, used only behind a confirmation. Accept and Decline in the cookie banner are deliberately identical in weight.

### Tags (signature component)
- **Style:** the shipping-tag shape (see Shapes) in Tag Stock with Tag Ink, 600 weight at the Label size (0.875rem; Meta, 0.8125rem, inside bookmark rows), and a 1px Tag Stock Edge under it.
- **State:** hover deepens to Tag Stock Hover. Selected (`.tag-stock--active`) turns solid Stash Violet with white ink and a white eyelet ring. In the sidebar rack, tag size scales with usage, and each rack tag carries sibling "+" (add to query) and star (favorite tag, marigold when on) buttons.
- **Rule:** wherever a tag appears (rows, rack, filters, tag inputs, the Tags page, the homepage demo) it uses this one component.

### Chips
- **Filter chip:** a Stash Violet Wash pill with Stash Violet Bright text (600, Meta size) showing the active filter inside the search field, truncated at 180px.
- **Show-only toggles:** bordered buttons (7px corners, 44px minimum height, Hairline Strong border) with a label and a tabular count ("Favorites 4", "Has note 0"). When active they take a Stash Violet Wash fill with Stash Violet Bright border and text.

### Cards / Containers
- **Corner Style:** 14px for main panels, 12px for summary cards such as the plan meter.
- **Background:** Graphite Panel on Graphite Ground.
- **Shadow Strategy:** none (see The Flat Bench Rule).
- **Border:** 1px Hairline.
- **Internal Padding:** 1.1rem.

### Bookmark Index
The library is one panel holding one row per bookmark, like an index, with 1px Hairline dividers between rows. A row shows the favicon (18px, 4px corners), the Row Title, the date on the right in Caption, then the domain, the description in Body Small and the tags. All of these indent under the title. A row being edited takes the raised tone and a 3px inset Stash Violet bar on its left edge. Select mode adds a checkbox column.

### Inputs / Fields
- **Search:** 2.85rem tall, 10px corners, Graphite Panel fill, Field Edge border, a leading search icon, and a favorites star and filter chip inside the field.
- **Form fields:** 0.75rem padding, 8px corners, a faint surface-wash fill, Field Edge border, 1rem text.
- **Focus:** the border turns Stash Violet Bright and a 3px violet halo appears.
- **Error:** inline Danger Rose text on a Danger wash banner. Hints use Caption in Ink Muted, linked with `aria-describedby`.

### Navigation
The header row has the logo (3.1rem tall, a light and a dark variant) and primary nav as ghost-style links with icons (Bookmarks, Tags, Duplicates, Trash, Settings): 2.4rem tall, 8px corners, Ink Soft at 500. The active link gets the surface wash, full Ink at 600 and a Stash Violet Bright icon. On the right are the theme selector and the account name with "Log out". A hairline sits under the header. The theme selector is a pill that shows the current theme's icon and expands on hover or focus to all three options in a fixed order. At 1024px and below, nav moves behind a bordered 2.5rem menu toggle.

Settings uses a grouped sidebar with Library, Account, Sharing & API, Billing and a separated Danger zone; super admins also see Administration. Preferences opens by default. Section links use a tinted current state and ordinary keyboard navigation. At 800px and below, a disclosure shows the current section and opens the grouped links above the content; choosing a link closes it and focuses the section heading.

## Do's and Don'ts

### Do:
- **Do** route every color, shadow and background through the `--color-*` / `--shadow-*` / `--theme-gradient` variables, and check new work in Slate, Midnight and Light.
- **Do** keep Stash Violet for primary actions, selection and focus, with at most one primary button per view.
- **Do** use the shared tag component for every tag, and set `--tag-eyelet` to the surface color when a tag sits on something other than a panel.
- **Do** separate surfaces with 1px hairlines and tone, and keep shadows for floating layers.
- **Do** take every font size from a `--text-*` role token and every family from `--font-sans` / `--font-mono`; use tabular figures for counts and dates.
- **Do** keep a visible 3px Stash Violet Bright focus outline on every interactive element, and honor reduced motion (transitions collapse to short opacity fades).
- **Do** keep transitions short and functional (0.15s to 0.25s ease, color and border only).

### Don't:
- **Don't** make it playful or cartoonish: no mascots, illustrations or bouncy motion.
- **Don't** move rows, cards or buttons on hover (no lift, scale or translate); reveal and recolor instead.
- **Don't** put shadows on panels, rows or cards that sit on the page.
- **Don't** introduce a second saturated accent, or use marigold for anything but favorites.
- **Don't** hardcode theme-sensitive hex values in component CSS, or dim text with `opacity`.
- **Don't** make a tag fill translucent; the point and body would show a seam.
- **Don't** use inline `style="..."` attributes or injected `<style>` tags; the site's CSP blocks them. Styles live in same-origin CSS files.
- **Don't** make cookie-consent Accept look more prominent than Decline.
