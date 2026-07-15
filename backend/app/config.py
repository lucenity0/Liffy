from pydantic import Field
from pydantic_settings import BaseSettings

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
    jwt_secret_key: str = Field(default="dev-secret-change-in-production")
    jwt_algorithm: str = Field(default="HS256")
    access_token_expire_minutes: int = Field(default=15)
    refresh_token_expire_days: int = Field(default=30)

    # OpenAI
    openai_api_key: str = Field(default="")

    # ChromaDB — HTTP server when chroma_host is set (compose); local persistent dir otherwise
    chroma_host: str = Field(default="")
    chroma_port: int = Field(default=8000)
    chroma_persist_dir: str = Field(default="./chroma")

    # App
    debug: bool = Field(default=True)

    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
