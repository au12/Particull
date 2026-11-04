# Changelog

## Unreleased

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
