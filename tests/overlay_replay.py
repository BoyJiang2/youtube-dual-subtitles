from pathlib import Path
from playwright.sync_api import sync_playwright
import os

repo = Path(__file__).resolve().parents[1]
with sync_playwright() as pw:
    browser = pw.chromium.launch(channel='chrome', executable_path=os.environ.get('CHROME_PATH'), headless=True)
    page = browser.new_page(viewport=dict(width=1280, height=720))
    page.set_content('<div id="movie_player" style="width:100vw;height:90vh;position:relative"><video></video></div>')
    page.evaluate("""() => {
      window.chrome.runtime = { id:'test', onMessage:{ addListener(f){window.deliver=f}, removeListener(){} }, sendMessage:async()=>{} };
      const v = document.querySelector('video');
      Object.defineProperty(v, 'paused', {get:()=>false});
      window.emit = (type, data={}) => deliver({target:'overlay', id:'s', type, revision:0, ...data}, {id:'test'}, ()=>{});
      window.cue = (event, data) => emit('captionEvent', {event,...data});
      window.state = () => Array.from(document.querySelector('#yt-dual-subtitles-host').shadowRoot.querySelectorAll('.cue-card:not([hidden])')).map(c => [c.children[0].textContent, c.children[1].textContent]);
    }""")
    page.add_script_tag(path=str(repo/'overlay.js'))
    page.evaluate("""() => {
      emit('start', {targetLanguage:'zh-Hans'});
      cue('final', {utteranceId:1, original:'Take the turn.'});
      cue('translation', {utteranceId:1, translated:'转弯。', done:true});
      cue('interim', {utteranceId:2, text:'Follow the road'});
    }""")
    frame = lambda: page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    frame()
    assert page.evaluate('state()') == [['Follow the road', '']], page.evaluate('state()')
    page.evaluate("""() => {
      cue('translation', {utteranceId:1, translated:'旧句迟到。', done:true});
      cue('interimTranslation', {utteranceId:1, original:'Take the turn', translated:'错误预览'});
      cue('interimTranslation', {utteranceId:2, original:'Follow the road', translated:'沿路'});
    }""")
    frame()
    assert page.evaluate('state()') == [['Follow the road', '沿路']]
    y = page.locator('.line-original:visible').last.bounding_box()['y']
    page.evaluate("""cue('final', {utteranceId:2, original:'Follow the road.', translated:'沿路'})""")
    frame()
    assert page.evaluate('state()') == [['Follow the road.', '沿路']]
    assert abs(y - page.locator('.line-original:visible').last.bounding_box()['y']) < 1
    page.evaluate("""cue('translation', {utteranceId:2, translated:'沿着这条路。', done:true})""")
    frame()
    assert page.evaluate('state()') == [['Follow the road.', '沿着这条路。']]
    assert page.locator('.history-trans').all_text_contents() == ['旧句迟到。','沿着这条路。']
    page.evaluate("""() => {
      cue('interim', {utteranceId:3, text:'Wait for the bus'});
      cue('interimTranslation', {utteranceId:3, original:'Wait for the bus', translated:'等公交车', done:true});
      cue('interim', {utteranceId:3, text:'Wait for the bus here'});
      cue('interimTranslation', {utteranceId:3, original:'Wait for the bus here', translated:'在', done:false});
    }""")
    frame()
    assert page.evaluate('state()') == [['Wait for the bus here', '等公交车']]
    page.evaluate("""cue('final', {utteranceId:3, original:'Wait for the bus here.', translated:'在', done:false})""")
    frame()
    assert page.evaluate('state()') == [['Wait for the bus here.', '等公交车']]
    page.evaluate("""cue('translation', {utteranceId:3, translated:'在这里等车。', done:true})""")
    frame()
    assert page.evaluate('state()') == [['Wait for the bus here.', '在这里等车。']]
    print('Chrome overlay replay passed: one current card, no stale rewind, translation survives final, stable baseline, both history entries.')
    browser.close()
