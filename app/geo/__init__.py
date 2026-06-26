"""app/geo — server-side Google Places + US Census ACS location services.

The browser never holds the Places/Census keys or calls those APIs directly
(CLAUDE.md hard rule 7). `client.py` wraps the two providers behind one network
seam; `derive.py` composes them into the address -> trade-area household count
the wizard consumes (editable, but evidence-backed). The engine still reads
H = trade_area.households — this only sources the default.
"""
