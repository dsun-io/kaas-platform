import re

with open('app/api/pricing_data.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

output = []
i = 0
while i < len(lines):
    line = lines[i]
    if 'return JSONResponse(' in line:
        # Find the complete block
        block_lines = [line]
        j = i + 1
        depth = line.count('(') - line.count(')')
        while j < len(lines) and depth > 0:
            block_lines.append(lines[j])
            depth += lines[j].count('(') - lines[j].count(')')
            j += 1
        
        block = ''.join(block_lines)
        
        # Extract status code
        sc_match = re.search(r'status_code=(\d+)', block)
        status = sc_match.group(1) if sc_match else '200'
        
        # Extract message from content dict
        msg_match = re.search(r'["\']message["\']\s*:\s*(f?["\'](?:[^"\']|\\.)*["\'])', block)
        if not msg_match:
            # Try f-string pattern
            msg_match = re.search(r'["\']message["\']\s*:\s*(f["\'][^"\']*["\'])', block)
        
        if status.startswith('2'):
            # Success response - extract content dict and return as dict
            content_match = re.search(r'content=\{([\s\S]*?)\n\s*\}\s*\)', block)
            if content_match:
                output.append(f'    return {{{content_match.group(1)}\n    }}\n')
            else:
                output.append(block)
        else:
            # Error response - HTTPException
            if msg_match:
                msg = msg_match.group(1)
                output.append(f'        raise HTTPException(status_code={status}, detail={msg})\n')
            else:
                output.append(block)
        
        i = j
    else:
        output.append(line)
        i += 1

with open('app/api/pricing_data.py', 'w', encoding='utf-8') as f:
    f.writelines(output)

print('Done')
