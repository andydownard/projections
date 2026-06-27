"""app.penny — Penny agentic assistant server foundations (Spec B, issue #122).

PE3 ships the provider abstraction (Anthropic primary -> OpenAI fallback ->
AI-disabled) and the bounded server-side tool-use loop. The seven real tools
plug into the tool-registry seam in PE4; Penny never computes a number and never
mutates outside the normal server validation path.
"""
