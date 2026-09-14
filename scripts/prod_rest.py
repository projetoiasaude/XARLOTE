"""
Leitura (e RPC) da PRODUÇÃO via PostgREST com a service role do `.env` — só da máquina do
fundador. Nasceu em 13/09/2026 quando o MCP do Supabase passou a negar tudo ("You do not
have permission"): `exec_sql` NÃO existe no banco, então SQL livre não roda por aqui — só
tabelas/filtros do PostgREST e RPCs existentes (ex.: `write_audit`). Migrations continuam
exigindo o fundador reconectar o MCP.

Uso (de qualquer script python3 no mesmo dir ou com sys.path):
    from prod_rest import get, rpc, ts
    rows = get('messages', [('select','id,content'), ('created_at','gte.2026-09-10T03:00:00Z'), ('order','created_at.asc')])
    rpc('write_audit', {...})
`get` pagina de 1000 em 1000 (Range) e aceita dict OU lista de tuplas (pra repetir chaves como
created_at gte/lte). `ts()` converte o ISO da API pra datetime em America/Sao_Paulo.
Nunca imprima a service key; nunca use pra escrever fora de reparo auditado.
"""
import json, urllib.request, urllib.parse
env = {}
for line in open('/Users/hiagovieira/IA_da_saude/.env', encoding='utf-8'):
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1); env[k] = v.strip().strip('"').strip("'")
BASE = env['SUPABASE_URL'].rstrip('/') + '/rest/v1/'
KEY = env['SUPABASE_SERVICE_ROLE_KEY']
def get(table, params, limit=1000, max_rows=20000):
    out = []; start = 0
    while True:
        q = urllib.parse.urlencode(params if isinstance(params, list) else list(params.items()), safe='*,().:+@ ')
        req = urllib.request.Request(BASE + table + '?' + q, headers={
            'apikey': KEY, 'Authorization': f'Bearer {KEY}',
            'Range': f'{start}-{start+limit-1}', 'Range-Unit': 'items'})
        with urllib.request.urlopen(req, timeout=60) as r:
            chunk = json.loads(r.read().decode())
        out.extend(chunk)
        if len(chunk) < limit or len(out) >= max_rows: break
        start += limit
    return out
def rpc(name, args):
    req = urllib.request.Request(BASE + 'rpc/' + name, data=json.dumps(args).encode(), method='POST',
        headers={'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())
import re
from datetime import datetime, timezone, timedelta
SP = timezone(timedelta(hours=-3))
def ts(s):
    """ISO da API (frações de tamanho variável, Z ou +00:00) -> datetime em SP."""
    s = s.replace('Z', '+00:00')
    s = re.sub(r'\.(\d{1,6})\d*', lambda m: '.' + m.group(1).ljust(6, '0'), s)
    return datetime.fromisoformat(s).astimezone(SP)
