# Changelog

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
