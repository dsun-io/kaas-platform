const fs = require('fs');
let c = fs.readFileSync('backend/orchestrator/app/api/invoice.py', 'utf8');

const pattern = /(tenant_id = getattr\(request\.state, "tenant_id", None\)\r?\n)(\s+if not tenant_id:\r?\n)(\s+raise HTTPException\(status_code=400, detail="tenant_id missing"\)\r?\n)/g;

c = c.replace(pattern, (match, p1, p2, p3) => {
    const indent = p2.match(/\s*/)[0];
    return p1 + indent + 'require_tenant_access(auth, tenant_id)\n' + p2 + p3;
});

fs.writeFileSync('backend/orchestrator/app/api/invoice.py', c);
console.log('Fixed tenant isolation');
