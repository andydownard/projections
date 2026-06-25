"""engine — THE SINGLE MATH AUTHORITY (pure compute core).

compute.py and friends import NO web/Excel/network/clock modules (ARCHITECTURE §4,
ENGINE_CONTRACT §0/§15). Renderers (xlsx.py, packet.py) consume the core output.
"""
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION

__all__ = ["MODEL_VERSION", "COMPUTE_SCHEMA_VERSION"]
