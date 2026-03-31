$env:OLLAMA_BASE="http://127.0.0.1:11434/v1"
$env:PRIMARY_MODEL="deepseek-v3.1:671b-cloud"
$env:CHALLENGER_MODEL="qwen3-coder-next:cloud"
$env:AUDIT_PACKET_PATH="$PWD\deepseek_qwen_audit_packet.md"
node .\tools\audit-orchestrator\server.mjs
