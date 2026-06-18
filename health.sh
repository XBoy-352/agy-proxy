#!/bin/bash
# Quick health check for agy-proxy (port 3457)
echo "=== agy-proxy health check ==="
echo ""

# Check if process is running
if pgrep -f "agy.*server.mjs" > /dev/null 2>&1; then
    echo "✓ Process: running"
else
    echo "✗ Process: NOT running"
fi

# Check HTTP endpoint
if response=$(curl -sf http://127.0.0.1:3457/health 2>/dev/null); then
    echo "✓ HTTP: responding"
    echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
else
    echo "✗ HTTP: NOT responding on http://127.0.0.1:3457"
fi

# Check models endpoint
if models=$(curl -sf http://127.0.0.1:3457/v1/models 2>/dev/null); then
    count=$(echo "$models" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))" 2>/dev/null)
    echo "✓ Models: $count available"
else
    echo "✗ Models: NOT available"
fi
echo ""

# Check agy binary
if command -v agy &> /dev/null; then
    echo "✓ agy binary: $(which agy)"
else
    echo "✗ agy binary: NOT found in PATH"
fi

echo ""
echo "=== done ==="
