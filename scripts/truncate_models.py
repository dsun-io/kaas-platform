with open('backend/orchestrator/app/db/models.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()
with open('backend/orchestrator/app/db/models.py', 'w', encoding='utf-8') as f:
    f.writelines(lines[:1196])
print(f'Truncated models.py to {len(lines[:1196])} lines')
