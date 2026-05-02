from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field

# 1. user.login
class UserLoginPayload(BaseModel):
    user_id: str
    ip: Optional[str] = None
    user_agent: Optional[str] = None

# 2. user.logout
class UserLogoutPayload(BaseModel):
    user_id: str

# 3. app.create
class AppCreatePayload(BaseModel):
    app_id: str
    name: str
    type: str

# 4. app.delete
class AppDeletePayload(BaseModel):
    app_id: str

# 5. kb.sync_job
class KbSyncJobPayload(BaseModel):
    kb_id: str
    job_id: str
    status: Literal['pending', 'processing', 'completed', 'failed']
    files_count: int = 0
    error_message: Optional[str] = None

# 6. kb.edit
class KbEditPayload(BaseModel):
    dataset_name: str
    chunk_id: Optional[str] = None
    action: Literal['create', 'update', 'delete']
    actor_id: str

PAYLOAD_SCHEMAS: Dict[str, type[BaseModel]] = {
    "user.login": UserLoginPayload,
    "user.logout": UserLogoutPayload,
    "app.create": AppCreatePayload,
    "app.delete": AppDeletePayload,
    "kb.sync_job": KbSyncJobPayload,
    "kb.edit": KbEditPayload,
}
