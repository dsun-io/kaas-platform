import re

with open('app/api/pricing_data.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

result = []
i = 0
while i < len(lines):
    line = lines[i]
    # Check if this line starts a JSONResponse
    if 'return JSONResponse(' in line:
        # Collect the entire JSONResponse block
        block = [line]
        j = i + 1
        paren_depth = line.count('(') - line.count(')')
        while j < len(lines) and paren_depth > 0:
            block.append(lines[j])
            paren_depth += lines[j].count('(') - lines[j].count(')')
            j += 1
        
        block_text = ''.join(block)
        
        # Extract status_code
        status_match = re.search(r'status_code=(\d+)', block_text)
        status_code = status_match.group(1) if status_match else '200'
        
        # Extract content dict
        content_match = re.search(r'content=\{([\s\S]*?)\n\s*\}', block_text)
        if content_match:
            content_dict = content_match.group(1)
            # Try to extract message
            msg_match = re.search(r'["\']message["\']\s*:\s*(f?["\'].*?["\']|[\w_]+)', content_dict, re.DOTALL)
            if msg_match:
                msg = msg_match.group(1)
                if status_code.startswith('2'):
                    result.append(f'    return {{{content_dict}\n    }}\n')
                else:
                    result.append(f'        raise HTTPException(status_code={status_code}, detail={msg})\n')
            else:
                # Fallback: return as dict for success, exception for error
                if status_code.startswith('2'):
                    result.append(f'    return {{{content_dict}\n    }}\n')
                else:
                    result.append(f'        raise HTTPException(status_code={status_code}, detail="error")\n')
        else:
            result.append(block_text)
        
        i = j
    else:
        result.append(line)
        i += 1

with open('app/api/pricing_data.py', 'w', encoding='utf-8') as f:
    f.writelines(result)

print('pricing_data.py updated')
