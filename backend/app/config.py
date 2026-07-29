from pydantic import Field
from pydantic_settings import BaseSettings

# Placeholder so a fresh clone runs without setup. It is a public constant in a
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
    # Server-side PAT used until per-user OAuth lands (token seam in github_service).
    github_token: str = Field(default="")
    
    # JWT
    jwt_secret_key: str = Field(default=DEV_JWT_SECRET)
    jwt_algorithm: str = Field(default="HS256")
    access_token_expire_minutes: int = Field(default=15)
    refresh_token_expire_days: int = Field(default=30)
    
    # LLM provider (OpenAI-compatible API; leave base_url empty for real OpenAI.
    # For Gemini: base_url=https://generativelanguage.googleapis.com/v1beta/openai/
    # with llm_model=gemini-2.5-flash, embedding_model=gemini-embedding-001)
    openai_api_key: str = Field(default="")
    openai_base_url: str = Field(default="")
    llm_model: str = Field(default="gpt-4o")  # review-generation model
    embedding_model: str = Field(default="text-embedding-3-small")

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
