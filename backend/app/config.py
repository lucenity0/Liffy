from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

# Development default so a fresh clone runs without setup. It is a constant in a
# public repo, so anything signed with it is forgeable by anyone who can read
# this file — auth_service refuses to mint tokens with it outside debug mode.
# 48 bytes clears the 32-byte RFC 7518 minimum for HS256.
DEV_JWT_SECRET = "dev-only-insecure-secret-change-me-before-deploy"

class Settings(BaseSettings):
    # Database
    database_url: str = Field(default="postgresql://localhost/liffy")
    
    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0")
    
    # GitHub OAuth
    github_client_id: str = Field(default="")
    github_client_secret: str = Field(default="")
    github_webhook_secret: str = Field(default="change-me")
    # Must byte-match the callback URL registered on the GitHub OAuth App —
    # scheme, host, port and path, with no trailing slash. A mismatch fails at
    # GitHub's end with an unhelpful error rather than anywhere in this code.
    github_redirect_uri: str = Field(default="http://localhost:8000/auth/github/callback")
    # Server-side PAT used until per-user OAuth lands (token seam in github_service).
    github_token: str = Field(default="")
    
    # JWT
    jwt_secret_key: str = Field(default=DEV_JWT_SECRET)
    jwt_algorithm: str = Field(default="HS256")
    access_token_expire_minutes: int = Field(default=15)
    refresh_token_expire_days: int = Field(default=30)

    @field_validator("jwt_secret_key")
    @classmethod
    def _blank_means_unset(cls, value: str) -> str:
        """Treat an empty JWT_SECRET_KEY as absent.

        ``docker-compose.yml`` passes ``JWT_SECRET_KEY: ${JWT_SECRET_KEY:-}``,
        which sets the variable to an empty string when the host has not
        exported one. That would otherwise override this field's default and
        break token minting with a confusing key-length error, so an empty
        value falls back to the development default — which is still refused
        outright when DEBUG=False.
        """
        return value or DEV_JWT_SECRET
    
    # ── Review LLM ────────────────────────────────────────────────────────────
    # "anthropic" uses the official SDK; "openai" speaks the OpenAI wire format
    # and therefore also covers anything that emulates it — Gemini's compat
    # endpoint, or a local Ollama at http://localhost:11434/v1 (no key, no cost).
    llm_provider: str = Field(default="anthropic")
    anthropic_api_key: str = Field(default="")
    openai_api_key: str = Field(default="")
    openai_base_url: str = Field(default="")
    llm_model: str = Field(default="claude-opus-5")  # review-generation model
    # Caps thinking *and* response text together on Claude models, where
    # thinking is on by default — too tight and the review truncates mid-JSON,
    # which reads like a parser bug rather than a budget problem.
    llm_max_tokens: int = Field(default=16000)

    # ── Embeddings ────────────────────────────────────────────────────────────
    # Local by default: no key, no quota, no billing in the retrieval path, so
    # CI and demos cannot be broken by someone else's account state.
    embedding_provider: str = Field(default="local")
    embedding_model: str = Field(default="text-embedding-3-small")  # openai only
    local_embedding_model: str = Field(default="BAAI/bge-small-en-v1.5")  # 384-dim

    # ChromaDB — HTTP server when chroma_host is set (compose); local persistent dir otherwise
    chroma_host: str = Field(default="")
    chroma_port: int = Field(default=8000)
    chroma_persist_dir: str = Field(default="./chroma")
    
    # App
    debug: bool = Field(default=True)

    # CORS — comma-separated, NOT list[str]: pydantic-settings parses list fields
    # from env as JSON, so "http://a,http://b" would raise at import time.
    # 5174 is where Vite lands when 5173 is already taken (a second checkout).
    cors_origins: str = Field(
        default="http://localhost:5173,http://localhost:5174"
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
