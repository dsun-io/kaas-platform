import re

with open('backend/orchestrator/app/api/invoice.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern: find tenant_id extraction and add require_tenant_access after the if block
old_pattern = r'(tenant_id = getattr\(request\.state, "tenant_id", None\)\n)(\s+if not tenant_id:\n)(\s+raise HTTPException\(status_code=400, detail="tenant_id missing"\)\n)'

def replacer(m):
    indent = m.group(2)
    return (
        f'{m.group(1)}'
        f'{indent}require_tenant_access(auth, tenant_id)\n'
        f'{m.group(2)}{m.group(3)}'
    )

content = re.sub(old_pattern, replacer, content)

with open('backend/orchestrator/app/api/invoice.py', 'w', encoding='utf-8') as f:
    f.write(content)

print('Fixed tenant isolation in api/invoice.py')
