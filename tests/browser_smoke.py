from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
import json
import math
import os
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT
CHROME = os.environ.get('CHROME_PATH', r'C:\Program Files\Google\Chrome\Application\chrome.exe')
VIDEO = 'https://www.youtube.com/watch?v=caption-test-fixture'
LINE = 'Welcome to the live stream.'
test_files = tempfile.TemporaryDirectory(prefix='youtube-caption-tests-', ignore_cleanup_errors=True)
WORK = Path(test_files.name)
requests = []
failures = []
slow_requests = []
slow_finished = threading.Event()
late = any(argument.startswith('--latency') for argument in sys.argv)
latency_provider = 'deepseek' if '--latency=deepseek' in sys.argv else 'openai'
slow_translation = '--slow-translation' in sys.argv
sync_view = any(argument.startswith('--sync') for argument in sys.argv)
sync_provider = 'deepseek' if '--sync=deepseek' in sys.argv else 'openai'
original_only = '--original' in sys.argv
OLD_LINE = 'This delayed line must never display.'

PAGE = b'''<!doctype html><meta charset=utf-8>
<div id=movie_player style="position:relative;width:810px;height:460px;background:#14201e">
  <video loop src="/speech.wav" width="600"></video>
  <button id=play onclick="this.previousElementSibling.play()">Play audio</button>
  <button id=fullscreen onclick="this.parentElement.requestFullscreen()">Fullscreen</button>
</div>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, payload, content_type, status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith('/watch?'):
            self.send(PAGE.replace(b'/speech.wav', b'/timed.webm') if sync_view else PAGE, 'text/html')
        elif self.path == '/speech.wav':
            self.send((WORK / 'speech.wav').read_bytes(), 'audio/wav')
        elif self.path == '/timed.webm':
            self.send((WORK / 'timed.webm').read_bytes(), 'video/webm')
        else:
            self.send(b'', 'text/plain', 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        host = self.headers['Host'].split(':')[0]
        provider = {'api.openai.com': 'openai', 'api.deepseek.com': 'deepseek'}[host]
        try:
            authorized = self.headers['Authorization']
            if authorized == 'Bearer fake-invalid-key':
                self.send(b'{"error":{"message":"dummy-message"}}', 'application/json', 401)
                return
            assert authorized == f'Bearer fake-{provider}-key'
            if self.path.endswith('/chat/completions'):
                assert self.path == ('/v1/chat/completions' if provider == 'openai' else '/chat/completions')
                data = json.loads(body)
                source = data['messages'][-1]['content']
                assert not original_only, 'Original-only mode must never call the translation API'
                assert source in (LINE, OLD_LINE, 'Red segment.', 'Blue segment.')
                if provider == 'openai':
                    assert data['model'] == 'gpt-4.1-mini' and data['store'] is False
                else:
                    assert data['model'] == 'deepseek-flash' and data['thinking'] == {'type': 'disabled'}
                if slow_translation and source == OLD_LINE:
                    time.sleep(3.7)
                    slow_finished.set()
                translated = '欢迎来到直播间。' if source == LINE else OLD_LINE
                if sync_view:
                    assert 'Japanese (ja)' in data['messages'][0]['content']
                    translated = {'Red segment.': '赤い場面。', 'Blue segment.': '青い場面。'}[source]
                    time.sleep(0.9)
                result = {'choices': [{'message': {'content': translated}}]}
            else:
                assert self.path == ('/v1/audio/transcriptions' if provider == 'openai' else '/v1/tools/asr')
                multipart = BytesParser(policy=policy.default).parsebytes(
                    ('Content-Type: ' + self.headers['Content-Type'] + '\r\n\r\n').encode() + body,
                )
                fields = {item.get_param('name', header='content-disposition'): item.get_payload(decode=True)
                          for item in multipart.iter_parts()}
                with wave.open(BytesIO(fields['file'])) as audio:
                    assert (audio.getframerate(), audio.getsampwidth(), audio.getnchannels()) == (48000, 2, 1)
                    assert 1.0 <= audio.getnframes() / audio.getframerate() < 5
                    frames = audio.readframes(audio.getnframes())
                    assert any(frames)
                if provider == 'openai':
                    assert fields['model'] == b'gpt-transcribe' and 'languages[]' not in fields
                else:
                    assert set(fields) == {'file'}
                result = {'text': LINE}
                if sync_view:
                    samples = [n for (n,) in struct.iter_unpack('<h', frames) if abs(n) > 350]
                    turns = sum(a * b < 0 for a, b in zip(samples, samples[1:]))
                    tone = turns / (len(samples) / 48_000) / 2
                    result = {'text': 'Red segment.' if tone < 530 else 'Blue segment.'}
                    time.sleep(1.7)
                if late:
                    slow_requests.append(time.monotonic())
                    if len(slow_requests) == 1:
                        if not slow_translation:
                            time.sleep(5)
                            slow_finished.set()
                        result = {'text': OLD_LINE}
            requests.append((provider, self.path))
            self.send(json.dumps(result).encode(), 'application/json')
        except (ConnectionError, ssl.SSLEOFError):
            pass
        except Exception as error:
            failures.append(repr(error))
            self.send(b'{}', 'application/json', 500)


def run(server):
    port = server.server_port
    with tempfile.TemporaryDirectory(dir=WORK, ignore_cleanup_errors=True) as profile, sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=CHROME, headless=True,
            ignore_default_args=['--disable-extensions', '--mute-audio'],
            args=[
                '--enable-unsafe-extension-debugging', '--ignore-certificate-errors', '--no-proxy-server',
                '--host-resolver-rules=' + ','.join(f'MAP {host} 127.0.0.1:{port}'
                    for host in ('www.youtube.com', 'api.openai.com', 'api.deepseek.com')),
            ],
        )
        browser = context.browser
        page = context.pages[0]
        cdp = context.new_cdp_session(page)
        browser_cdp = browser.new_browser_cdp_session()
        print(cdp.send('Browser.getVersion')['product'], flush=True)
        extension_id = browser_cdp.send('Extensions.loadUnpacked', {'path': str(EXTENSION)})['id']
        print('Loaded extension via CDP', flush=True)
        page.goto(VIDEO, wait_until='domcontentloaded')
        page.get_by_role('button', name='Play audio').click()
        page.wait_for_function('!document.querySelector("video").paused')
        target_id = browser_cdp.send('Target.getTargets', {'filter': [{'type': 'tab'}]})['targetInfos'][0]['targetId']

        messages = {}
        browser_cdp.on('Target.receivedMessageFromTarget',
                       lambda event: messages.update({event['sessionId']: json.loads(event['message'])}))

        def wait(predicate, timeout=8):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = predicate()
                if value:
                    return value
                page.wait_for_timeout(50)
            raise AssertionError('Timed out')

        def action(session, method, params):
            messages.pop(session, None)
            browser_cdp.send('Target.sendMessageToTarget', {
                'sessionId': session, 'message': json.dumps({'id': 1, 'method': method, 'params': params}),
            })
            result = wait(lambda: messages.get(session))
            assert 'error' not in result, result
            return result['result']

        class Popup:
            def __init__(self, target):
                self.target = target
                self.session = browser_cdp.send('Target.attachToTarget', {'targetId': target})['sessionId']

            def js(self, expression):
                result = action(self.session, 'Runtime.evaluate', {'expression': expression, 'returnByValue': True})
                assert 'exceptionDetails' not in result, result
                return result['result'].get('value')

            def click(self, selector):
                self.js(f'document.querySelector({json.dumps(selector)}).click()')

            def close(self):
                browser_cdp.send('Target.closeTarget', {'targetId': self.target})

        def popup():
            browser_cdp.send('Extensions.triggerAction', {'id': extension_id, 'targetId': target_id})
            def find_target():
                targets = browser_cdp.send('Target.getTargets', {'filter': [{'type': 'page'}]})['targetInfos']
                return next((target['targetId'] for target in targets if target['url'].endswith('/popup.html')), None)
            ui = Popup(wait(find_target))
            wait(lambda: ui.js('document.querySelector("#key")?.placeholder'))
            return ui

        if sync_view:
            ui = popup()
            assert ui.js('document.querySelector("#synchronized").value') == 'yes'
            assert ui.js('document.querySelector("#target-language").options.length') == 47
            ui.js(f'document.querySelector("#provider").value = "{sync_provider}"; document.querySelector("#key").value = "fake-{sync_provider}-key"; document.querySelector("#target-language").value = "ja"')
            if original_only:
                ui.js('const mode = document.querySelector("#subtitle-mode"); mode.value = "original"; mode.dispatchEvent(new Event("change"));')
                assert ui.js('document.querySelector("#target-setting").hidden')
            with context.expect_page(timeout=12_000) as event:
                ui.click('#toggle')
            viewer = event.value
            viewer.wait_for_load_state('domcontentloaded')
            try:
                wait(lambda: '同步播放中' in viewer.locator('#status').text_content() or viewer.locator('#play').is_visible(), timeout=22)
            except Exception:
                print('Viewer status:', viewer.locator('#status').text_content(), 'API failures:', failures, flush=True)
                raise
            if viewer.locator('#play').is_visible():
                viewer.locator('#play').click()

            result = viewer.evaluate('''async only => {
              const video = document.querySelector('video');
              const src = document.querySelector('#original');
              const dst = document.querySelector('#translated');
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const paint = canvas.getContext('2d', { willReadFrequently: true });
              const audioVideo = { red: 0, blue: 0, mismatched: 0, missingTranslations: 0, end: 0 };
              return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(JSON.stringify(audioVideo))), 18000);
                function frame(_, meta) {
                  audioVideo.end = meta.mediaTime;
                  paint.drawImage(video, video.videoWidth * .36, video.videoHeight * .29, 1, 1, 0, 0, 1, 1);
                  const [r, , b] = paint.getImageData(0, 0, 1, 1).data;
                  const caption = src.textContent;
                  const expected = caption === 'Red segment.' ? '赤い場面。' : '青い場面。';
                  if (r > 150 && b < 60 && caption === 'Red segment.') audioVideo.red++;
                  if (b > 150 && r < 60 && caption === 'Blue segment.') audioVideo.blue++;
                  if ((r > 150 && caption === 'Blue segment.') || (b > 150 && caption === 'Red segment.')) audioVideo.mismatched++;
                  if (caption && (only ? dst.textContent : dst.textContent !== expected)) audioVideo.missingTranslations++;
                  if (meta.mediaTime > 7) { clearTimeout(timer); resolve(audioVideo); }
                  else video.requestVideoFrameCallback(frame);
                }
                video.requestVideoFrameCallback(frame);
              });
            }''', original_only)
            print('Timed frame alignment:', result, flush=True)
            assert result['red'] > 10 and result['blue'] > 10 and result['mismatched'] == 0, result
            assert result['missingTranslations'] == 0, result
            assert viewer.locator('video').evaluate('video => video.webkitAudioDecodedByteCount > 0')
            viewer.locator('#stop').click()
            worker = next(worker for worker in context.service_workers if extension_id in worker.url)
            wait(lambda: worker.evaluate("async () => (await chrome.tabCapture.getCapturedTabs()).every(tab => tab.status !== 'active')"))
            assert not failures, failures
            if original_only:
                assert all('completions' not in endpoint for _, endpoint in requests)
            print('Synchronized playback, matching markers, decoded audio and clean stop passed', flush=True)
            context.close()
            return

        for provider in ((latency_provider,) if late else ('openai', 'deepseek')):
            ui = popup()
            ui.js(f'document.querySelector("#synchronized").value = "no"; document.querySelector("#provider").value = "{provider}"; document.querySelector("#key").value = "fake-{provider}-key"')
            ui.click('#toggle')
            try:
                wait(lambda: ui.js('document.querySelector("#toggle").dataset.stopping === "true" && !document.querySelector("#toggle").disabled'))
            except Exception:
                print('Popup status:', ui.js('document.querySelector("#message").textContent'), flush=True)
                print('Mock failures:', failures, flush=True)
                raise
            ui.close()
            if late:
                try:
                    page.get_by_text('欢迎来到直播间。', exact=True).wait_for(timeout=6000)
                except Exception:
                    print(f'First fresh translation did not arrive within 6 s. ASR requests started: {len(slow_requests)}', flush=True)
                    raise
                assert len(slow_requests) >= 2 and not slow_finished.is_set()
                elapsed = time.monotonic() - slow_requests[0]
                print(f'Fresh bilingual caption rendered {elapsed:.2f}s after the first segment request', flush=True)
                wait(slow_finished.is_set)
                assert page.get_by_text(OLD_LINE, exact=True).count() == 0
                page.evaluate('document.querySelector("video").pause()')
                page.get_by_text('欢迎来到直播间。', exact=True).wait_for(state='detached', timeout=1000)
                page.wait_for_timeout(500)
                assert page.get_by_text(LINE, exact=True).count() == 0
                count = len(slow_requests)
                page.wait_for_timeout(2300)
                assert len(slow_requests) == count
                page.get_by_role('button', name='Play audio').click()
                page.get_by_text('欢迎来到直播间。', exact=True).wait_for(timeout=5000)
                page.evaluate('document.querySelector("video").currentTime = 1')
                page.get_by_text('欢迎来到直播间。', exact=True).wait_for(state='detached', timeout=1000)
                page.get_by_text('欢迎来到直播间。', exact=True).wait_for(timeout=5000)
                print(f'{provider}: late subtitles discarded, pause stopped uploads, pause and seek cleared old captions', flush=True)
                break
            page.get_by_text(LINE, exact=True).wait_for(timeout=10_000)
            page.get_by_text('欢迎来到直播间。', exact=True).wait_for(timeout=10_000)
            assert page.locator('video').evaluate('(video) => !video.paused && !video.muted')
            print(f'{provider}: captured real tab audio, validated WAV and API requests, rendered both captions', flush=True)

            if provider == 'openai':
                page.bring_to_front()
                fullscreen = cdp.send('Runtime.evaluate', {
                    'expression': 'document.querySelector("#movie_player").requestFullscreen()',
                    'userGesture': True, 'awaitPromise': True,
                })
                assert 'exceptionDetails' not in fullscreen, fullscreen
                page.wait_for_function('document.fullscreenElement?.id === "movie_player"', timeout=5000)
                assert page.get_by_text('欢迎来到直播间。', exact=True).is_visible()
                page.evaluate('document.exitFullscreen()')
                ui = popup()
                ui.click('#toggle')
                wait(lambda: ui.js('document.querySelector("#toggle").dataset.stopping === "false" && !document.querySelector("#toggle").disabled'))
                ui.close()
            else:
                page.evaluate("history.pushState({}, '', '/watch?v=other-video')")
            page.get_by_text('欢迎来到直播间。', exact=True).wait_for(state='detached')
            time.sleep(.2)
            count = len(requests)
            page.wait_for_timeout(2300)
            assert len(requests) == count
            worker = next(worker for worker in context.service_workers if extension_id in worker.url)
            assert worker.evaluate("async () => (await chrome.tabCapture.getCapturedTabs()).every(tab => tab.status !== 'active')")

        if late:
            assert not failures, failures
            context.close()
            return
        ui = popup()
        assert ui.js('document.querySelector("#key").placeholder') == '已有密钥，留空继续使用'
        ui.js('document.querySelector("#key").value = "fake-invalid-key"')
        ui.click('#toggle')
        wait(lambda: ui.js('document.querySelector("#message").textContent') == 'DeepSeek 语音识别失败。请检查 API 密钥和模型访问权限。', timeout=10)
        ui.click('#forget')
        wait(lambda: ui.js('document.querySelector("#forget").hidden'))
        assert ui.js('document.querySelector("#key").placeholder') == '粘贴所选服务商的密钥'
        assert not failures, failures
        print('Fullscreen, manual stop, SPA video switch, auth failure and clearing keys passed', flush=True)
        context.close()


if __name__ == '__main__':
    work = WORK
    if sync_view and not (work / 'timed.webm').exists():
        with wave.open(str(work / 'timed.wav'), 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            waveform = []
            for n in range(6 * 16_000):
                t = n / 16_000
                freq = 300 if .4 <= t <= 2.1 else 720 if 3.4 <= t <= 5.1 else 0
                waveform.append(struct.pack('<h', int(14_000 * math.sin(2 * math.pi * freq * t))))
            wav.writeframes(b''.join(waveform) * 6)
        filters = "drawbox=c=red:t=fill:enable='between(mod(t,6),0.4,2.1)',drawbox=c=blue:t=fill:enable='between(mod(t,6),3.4,5.1)'"
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                        'color=black:s=600x360:r=30:d=36', '-i', str(work / 'timed.wav'), '-vf', filters,
                        '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '6', '-c:a', 'libopus', str(work / 'timed.webm')], check=True)
    if not (work / 'tls.pem').exists():
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', str(work / 'tls-key.pem'), '-out', str(work / 'tls.pem'),
                        '-subj', '/CN=localhost'], check=True, capture_output=True)
    if not (work / 'speech.wav').exists():
        subprocess.run(['powershell', '-NoProfile', '-Command',
                        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                        "try { $s.SetOutputToWaveFile('" + str(work / 'speech.wav') + "'); "
                        "$s.Speak(('Welcome to the live stream. This is a test of English speech for the bilingual subtitle extension. ' * 6)); } finally { $s.Dispose() }"],
                       check=True, capture_output=True)
    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(work / 'tls.pem', work / 'tls-key.pem')
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            run(server)
        finally:
            server.shutdown()
