# -*- coding: utf-8 -*-
"""
观古定名服务（独立运行版）
- 静态页面：web/ 目录下的 H5（原生 JS，无构建步骤）
- REST API：/api/naming/*（实现集中在 naming/api.py）
- 只用 Python 标准库：http.server + ThreadingHTTPServer + SimpleHTTPRequestHandler

用法：python server.py [端口]   默认 6700
"""
import json, os, socket, sys, time, threading
import http.server
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(ROOT)
sys.path.insert(0, os.path.join(PROJ, 'naming'))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from api import NamingAPI, ENGINE_VERSION, DEFAULT_DB   # noqa: E402

WEB_ROOT = os.path.join(PROJ, 'web')
DATA_DIR = os.path.join(PROJ, 'data')
DB_PATH = os.environ.get('NAMING_DB', DEFAULT_DB)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 6700

ACCESS_LOG = os.path.join(DATA_DIR, 'access.log')
os.makedirs(DATA_DIR, exist_ok=True)


def _log_access(kind, handler, extra=None):
    rec = {'t': time.strftime('%Y-%m-%d %H:%M:%S'), 'kind': kind,
           'ip': (handler.headers.get('X-Forwarded-For') or handler.client_address[0]).split(',')[0].strip(),
           'ua': (handler.headers.get('User-Agent') or '')[:100]}
    if extra:
        rec.update(extra)
    try:
        with open(ACCESS_LOG, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError:
        pass


API = NamingAPI(db_path=DB_PATH, data_dir=DATA_DIR, web_dir=WEB_ROOT, log_cb=_log_access)

# 静态根之外的内容一律拒绝（源码/数据库/日志/数据），避免 6600 站点那种源码可下载的问题
# 注意：业务接口位于 /api/naming/*，不能与源码目录 /naming/ 混淆
BLOCKED_SUFFIX = ('.py', '.db', '.sqlite', '.log', '.env', '.json', '.pem', '.key')
BLOCKED_SEG = ('/data/', '/engine/', '/naming/', '/db/', '/certs/', '/tools/', '/docs/')


def is_blocked(path):
    low = path.lower()
    if low.startswith('/api/naming/') or low == '/api/naming':
        return False                      # 业务接口放行
    if low.endswith(BLOCKED_SUFFIX):
        return True
    if any(seg in low for seg in BLOCKED_SEG):
        return True
    return low.startswith('/db') or low == '/server.py'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length', 0) or 0)
        except (TypeError, ValueError):
            n = 0
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return {}

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # ---------------- GET ----------------
    def guess_type(self, path):
        """静态资源统一声明 UTF-8。

        页面里全是中文，若 Content-Type 不带 charset，个别浏览器/代理会按本地编码猜，
        出现乱码。这里对文本类资源显式补上 charset=utf-8（html 本身也已有 meta charset）。
        """
        ctype = super().guess_type(path)
        if isinstance(ctype, tuple):
            ctype = ctype[0]
        if ctype.startswith('text/') or ctype in ('application/javascript',
                                                  'application/json', 'image/svg+xml'):
            if 'charset' not in ctype:
                ctype += '; charset=utf-8'
        return ctype

    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        if is_blocked(p):
            return self._json({'error': 'forbidden'}, 403)
        if p == '/api/health':
            return self._json({'ok': True, 'engine': ENGINE_VERSION,
                               'knowledge': API.kb.meta.get('knowledge_version'),
                               'chars': len(API.kb.hanzi), 'time': time.strftime('%F %T')})
        if p == '/api/stats':
            return self._stats()
        if p.startswith('/api/naming/'):
            if API.handle_get(p, q, self):
                _log_access('api', self, {'path': p})
                return
        if p in ('/', '/index.html', '/naming', '/naming.html'):
            _log_access('visit', self)
            if p in ('/naming', '/naming.html'):
                self.path = '/index.html'
        return super().do_GET()

    # ---------------- POST ----------------
    def do_POST(self):
        p = urlparse(self.path).path
        if not p.startswith('/api/naming/'):
            return self.send_error(404)
        body = self._body()
        try:
            if API.handle_post(p, body, self, self):
                return
            return self.send_error(404)
        except Exception as e:  # noqa
            import traceback
            traceback.print_exc()
            return self._json({'error': str(e)}, 500)

    def _stats(self):
        visit = gen = 0
        ips, by_day, by_principle = set(), {}, {}
        if os.path.exists(ACCESS_LOG):
            for line in open(ACCESS_LOG, encoding='utf-8'):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                ips.add(r.get('ip'))
                d = (r.get('t') or '')[:10]
                by_day[d] = by_day.get(d, 0) + 1
                if r.get('kind') == 'generate':
                    gen += 1
                    k = r.get('principles', '')
                    by_principle[k] = by_principle.get(k, 0) + 1
                elif r.get('kind') == 'visit':
                    visit += 1
        self._json({'页面访问': visit, '取名次数': gen, '独立IP': len(ips),
                    '按天': dict(sorted(by_day.items())), '按原则组合': by_principle,
                    '知识库': API.kb.meta.get('knowledge_version')})


def lan_ips():
    """列出本机可用于局域网访问的 IPv4 地址（不依赖第三方库）。"""
    ips = []
    try:
        # 连一个外部地址只为让系统选出默认出口网卡（不会真的发包）
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith('127.'):
                ips.append(ip)
    except OSError:
        pass
    return ips


def run():
    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print('取名服务已启动：')
    print('  本机      http://127.0.0.1:%d/' % PORT)
    ips = lan_ips()
    if ips:
        for ip in ips:
            print('  局域网    http://%s:%d/   ← 同一网络的人用这个地址' % (ip, PORT))
    else:
        print('  局域网    未识别到本机 IP，可用 ipconfig 查看 IPv4 地址后拼上端口')
    print('  接口      /api/health | /api/naming/options | /api/naming/principles | /api/stats')
    print('  知识库    %s（%d 字）  静态根：%s' % (
        API.kb.meta.get('knowledge_version'), len(API.kb.hanzi), WEB_ROOT))
    print()
    print('  别人打不开时按顺序查：')
    print('    1) 是否同一网络（同一 WiFi/交换机），访客 WiFi 常开了"AP 隔离"会互相不通')
    print('    2) Windows 防火墙是否放行本端口（需管理员执行一次）：')
    print('       netsh advfirewall firewall add rule name="取名服务6700" ^')
    print('         dir=in action=allow protocol=TCP localport=%d' % PORT)
    print('    3) 跨网络访问（异地同事）需要部署到公网服务器或用内网穿透，见 docs/03')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    run()
