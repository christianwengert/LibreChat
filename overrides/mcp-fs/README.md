# How to get npm packages to offline

## Online machine
```
mkdir mcp-fs && cd mcp-fs
npm init -y
npm install --no-fund --no-audit @modelcontextprotocol/server-filesystem@2025.8.21
tar -czf mcp-fs-offline.tar.gz package.json package-lock.json node_modules
```

## Offline machine
```
mkdir mcp-fs && cd mcp-fs
tar -xzf /path/to/mcp-fs-offline.tar.gz
# run the CLI (no internet needed):
npx mcp-server-filesystem /tmp
# or equivalently:
node node_modules/@modelcontextprotocol/server-filesystem/dist/index.js /tmp
```