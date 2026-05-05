"""
Kaas v2 · AUTH-WX-R1: Auth Pydantic schemas
"""
from pydantic import BaseModel
from typing import Optional


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str
    company_name: str
    product_category: str
    contact: Optional[str] = None
    # NOTE: account_type/role/plan are NOT accepted — server forces customer/owner/free


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    user_id: int
    email: str
    display_name: str
    account_type: str
    role: str
    plan: str
    customer_id: Optional[int] = None
    customer_code: Optional[str] = None
    customer_name: Optional[str] = None
    tenant_id: Optional[str] = None
    access_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    user_id: int
    email: str
    display_name: str
    account_type: str
    role: str
    plan: str
    customer_id: Optional[int] = None
    customer_code: Optional[str] = None
    customer_name: Optional[str] = None
    tenant_id: Optional[str] = None
