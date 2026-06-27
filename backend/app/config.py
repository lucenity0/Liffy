from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    github_webhook_secret: str = Field(default="change-me")


settings = Settings()
