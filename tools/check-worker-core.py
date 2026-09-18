#!/usr/bin/env python3
"""
Drive the worker smoke test in headless Chromium.

  pip install playwright && playwright install chromium
  pnpm build && node tools/check-worker-core.mjs
  python3 tools/check-worker-core.py [--cog URL] [--tiles TEMPLATE]

Serves dist/ (which must contain proj-wasm/ from the build and worker-smoke/
from the mjs step) on a local port, opens /worker-smoke/, and prints what the
worker reported. Exit status is the worker's ok flag.
"""
import argparse, http.server, json, mimetypes, os, pathlib, socketserver, sys, threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'


def serve(port):
    mimetypes.add_type('text/javascript', '.mjs')
    mimetypes.add_type('text/javascript', '.js')
    mimetypes.add_type('application/wasm', '.wasm')

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(DIST), **k)
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            super().end_headers()
        def log_message(self, *a):
            pass

    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cog', default=None)
    ap.add_argument('--tiles', default=None)
    ap.add_argument('--port', type=int, default=8791)
    args = ap.parse_args()
    if not (DIST / 'worker-smoke' / 'worker.js').exists():
        print('run: pnpm build && node tools/check-worker-core.mjs && pnpm build')
        sys.exit(2)
    from playwright.sync_api import sync_playwright
    srv = serve(args.port)
    q = []
    if args.cog: q.append('cog=' + args.cog)
    if args.tiles: q.append('tiles=' + args.tiles)
    url = f'http://127.0.0.1:{args.port}/worker-smoke/' + ('?' + '&'.join(q) if q else '')
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto(url)
        result = None
        for _ in range(120):
            result = pg.evaluate('window.__result')
            if result:
                break
            pg.wait_for_timeout(500)
        b.close()
    srv.shutdown()
    print(json.dumps(result, indent=1))
    sys.exit(0 if result and result.get('ok') else 1)


if __name__ == '__main__':
    main()
