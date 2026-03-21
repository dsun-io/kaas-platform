import secrets


def ensure_conversation_id(client_provided: str | None) -> str:
    if client_provided and client_provided.strip():
        return client_provided.strip()
    return f"conv_{secrets.token_hex(16)}"
