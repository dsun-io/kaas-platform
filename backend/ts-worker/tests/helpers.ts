/** 测试共享常量。bcrypt 哈希由 Python 侧生成（backend/worker venv，cost 12），证明 $2b$ 互通。 */
export const PYTHON_BCRYPT_HASH = "$2b$12$tQlccOVrGR5rA9lgHXiK9e.m0.05ExyC.KPs4h8fucs0IhrX69XdW";
export const TEST_PASSWORD = "ts-interop-test-password";
export const FIXED_SECRET = "ts-edge-test-secret-at-least-32-chars!!";
