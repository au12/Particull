# Changelog

## v0.3.0 (2026-11-14)

### Parts
- On a computer the list is a table: name, package, part number, location and amount, sorted by clicking a heading. Phones keep two-line rows. A column most parts leave empty is left out
- Only the rows on screen are drawn: with 1,600 parts the page holds about 660 elements instead of 18,800, and filtering takes 16 ms on a desktop (was 230 ms) and 66 ms on a slowed-down phone (was over a second)
- Wide screens show the chosen part beside the list instead of in a pop-up; changes save as you type, and the arrow keys move from part to part
- Where-used: a part's details list the projects that use it and how many each needs; parts your planned and building projects need more of than you have are flagged "Short", with a **Short for projects** filter
- History for every part (when, old → new, and why: edited, built, received, added from a kit) and undo for the last change, from the part's history, a toast after changing an amount, or ⌘Z / Ctrl+Z. One action is one undo, including a whole build, a kit or a received order
- Browse by location in the sidebar (and a Location menu on phones)
- Printable location labels with a QR code each, for Avery 5160, Avery 5163 or plain paper; scanning one opens that location's parts
- When every part in a category is in the same place, the location shows once next to the category
- Drop a CSV on the parts page, or paste a list while not typing in a field, to add parts from it
- Delete and Merge moved into a "…" menu in the part sheet

### Projects
- Lines that need you come first; the ones in stock fold away under one row, and the green "In stock" tags are gone
- The review notice is one line with **Accept all**; whether confirmed matches remember the BOM's name is now a setting
- The shopping list is a checklist: tick things off as they arrive, and "I got these" adds only what's ticked. Copy and CSV give what's still to get
- Import BOM is a drop area: paste, open or drop a file, and see how many parts it found and how many you already have before importing
- Drop a BOM file on a project, or paste one, to import it

### Everywhere
- ⌘K / Ctrl+K quick jump to parts, projects, locations and actions, also in the sidebar
- ? shows the keyboard shortcuts
- Pages are centered in the window; the sidebar folds to icons at iPad widths
- Contrast: secondary text and counts now meet WCAG AA (4.5:1) in light and dark themes; the lightest gray is kept for icons
- The search box no longer grabs focus when the page opens on a computer (press / to search); on phones the pinned search bar is opaque
- Export uses the share icon; on phones one + button holds Add part, Paste a list and Add a kit
- Loading shows placeholder rows instead of a blank page

### Fixes
- The shopping list and Import BOM sheets no longer show a stray "false" when a notice or option doesn't apply

## v0.2.0 (2026-11-03)

### Parts
- Plenty / Some / Running low / Out as an alternative to exact counts; BOM checks treat Plenty and Some as in stock and list Running low to top up
- Units per part (m, g, spool, pack…) and fractional amounts
- Add a kit: resistors (E6/E12/E24), ceramic and electrolytic capacitors, LEDs, connectors, diodes and transistors, screws and standoffs
- Select parts (or long-press on a phone) to move, recategorize, change how they're counted, merge or delete them together, with undo
- Merge duplicate parts: amounts add up, names become aliases, project lines follow
- Search understands values: `4k7`, `0.1u`, `3v3`

### Projects
- Status (Idea, Planned, Building, Done), grouped in the list; archive finished projects
- Building a planned project marks it Building

### Export and data
- Chat export collapses runs of resistors and capacitors into one line per kind and package
- Scheduled database backups (every 6 hours, daily or weekly) with a keep limit, back up now, restore from any backup or a .db file, and a safety copy before every restore
- Service worker: opens instantly from a saved copy and shows the last data when the server can't be reached

### Look and feel
- Redesigned in the spirit of classic Apple tools: system font (San Francisco on Apple devices, Inter elsewhere), inset grouped lists with hairline separators, filled buttons and fields, UIStepper-style quantity controls in forms (the parts list shows just the number, click to edit), green switches, translucent sidebar, menus and toasts
- On phones, page actions sit in a translucent top bar and the large title tucks into it as you scroll; the search bar stays pinned
- Settings laid out as grouped sections, like the Settings app

### Under the hood
- Browser tests for the main flows and a container smoke test run in CI before the image is published
- Transactions nest safely (fixes undo after deleting several parts)

## v0.1.0 (2026-11-03)

First release of Particull: a simple, self-hosted parts inventory for makers that checks project BOMs against what you have. A ground-up rebuild of Binner with the supplier integrations removed.

### Parts
- Hand entry with only a name and quantity required; category and location autocomplete and carry over to the next part
- Duplicate detection while typing, with "add to the existing part"
- Category suggestions from the part name
- Paste a list: plain lines (`10x 10k resistor`, `×2`, `, 3`), Markdown tables or CSV, with a preview and merge into existing parts
- Inline quantity steppers, search, sort, category filters, low/out-of-stock filter

### Projects and BOMs
- Import Markdown tables, CSV/TSV, KiCad BOM exports or plain lists
- Fuzzy matching that understands values, units, packages and part numbers (10K ohm res = 10k resistor, 0.1uF = 100nF), never suggesting a different value or component type
- Near-matches flagged for approval, one at a time or all at once, with the option to remember the BOM's wording as another name for the part
- Builds multiplier, shopping list (copy or CSV), "I got these" to add an order to inventory, and Build with undo

### Everything else
- Export for chat (Markdown, CSV or JSON) with instructions for a BOM format Particull imports
- Cost tracking setting, off by default
- Light and dark themes, phone-friendly layout
- Optional password, JSON backup and restore
- Docker image for amd64 and arm64 at `ghcr.io/au12/particull`, plus an Unraid template in `unraid/particull.xml`
