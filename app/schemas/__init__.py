"""app/schemas — Pydantic request/response models incl. the Appendix-D view-model.

Populated in M2 (the projections router + create/patch contracts). The view-model
SHAPE is owned by engine/compute.py (its native output); these schemas validate the
API boundary and serialize that shape. Kept as a package from M0 so the layout
matches ARCHITECTURE §7.
"""
