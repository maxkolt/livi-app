// HTML-страница YouTube-плеера Fliq (IFrame Player API) — отдельно от компонента,
// чтобы её логику (пауза, подгрузка, звук) можно было проверить тестом без WebView.

/**
 * Страница плеера грузится как html с этим адресом: YouTube требует у встраивающей
 * страницы настоящий https-источник (без него плеер отвечает ошибкой 152/153).
 */
export const PLAYER_ORIGIN = 'https://liviapp.com';

/** Состояния IFrame API: -1 не начат, 0 конец, 1 играет, 2 пауза, 3 буферизация, 5 подготовлен. */
export const YT_PLAYING = 1;

/**
 * play — играть; pause — ролик не на экране (ушли с вкладки, листаем), играть нельзя;
 * hold — человек сам поставил паузу: стоим, пока он не нажмёт «играть» в плеере.
 */
export type FliqPlayMode = 'play' | 'pause' | 'hold';

/**
 * Страница плеера. Кроме «играть/пауза»:
 * - подгрузка заранее (prebuffer): следующий ролик ленты тихо запускается без звука и сразу
 *   встаёт на паузу в начале — первые секунды уже скачаны, после свайпа старт почти мгновенный;
 *   пока идёт подгрузка, состояния плеера наружу не уходят (это ещё не «первый кадр»);
 * - звук общий для ленты: muted задаёт RN, а если человек нажал звук в самом плеере YouTube,
 *   страница замечает это (isMuted) и сообщает — тогда звук меняется у всех роликов.
 *
 * Плеер на 2 px заходит за каждый край окна: YouTube округляет размер видео до целых px,
 * и при дробной ширине карточки справа и снизу оставалась чёрная полоса фона страницы.
 */
export function youtubePlayerHtml(
  videoId: string,
  init: { mode: FliqPlayMode; muted: boolean; prebuffer: boolean; startSec: number },
): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}#p{position:absolute;top:-2px;left:-2px;width:calc(100% + 4px);height:calc(100% + 4px)}</style>
</head><body><div id="p"></div><script>
(function(){
  var player=null, ready=false, want='${init.mode}', muted=${init.muted}, prebuffer=${init.prebuffer};
  var buffering=false, buffered=false, tick=null, lastMuted=null, quietUntil=0;
  function send(m){try{window.ReactNativeWebView.postMessage(JSON.stringify(m));}catch(e){}}
  function applyMute(){
    if(!ready||buffering) return;
    // isMuted() догоняет команду с задержкой — не принять своё же переключение за нажатие человека.
    quietUntil=Date.now()+1500; lastMuted=null;
    try{ if(muted) player.mute(); else player.unMute(); }catch(e){}
  }
  function apply(){
    if(!ready) return;
    try{
      var s=player.getPlayerState();
      if(want==='play'){
        if(buffering){ buffering=false; applyMute(); if(s===1) send({t:'state',s:1}); }
        if(s!==1&&s!==3) player.playVideo();
      } else if(buffering){
        return;
      } else if(s===1||s===3){
        player.pauseVideo();
      } else if(want==='pause'&&prebuffer&&!buffered){
        buffering=true; quietUntil=Date.now()+1500; player.mute(); player.playVideo();
      }
    }catch(e){}
  }
  function pollMute(){
    if(!ready||buffering||Date.now()<quietUntil) return;
    try{
      var m=player.isMuted();
      if(lastMuted!==null&&m!==lastMuted){ muted=m; send({t:'mute',m:m}); }
      lastMuted=m;
    }catch(e){}
  }
  window.__fliq=function(c){ want=c; apply(); };
  window.__fliqMute=function(m){ muted=!!m; applyMute(); };
  window.__fliqPrebuffer=function(p){ prebuffer=!!p; apply(); };
  window.onYouTubeIframeAPIReady=function(){
    player=new YT.Player('p',{width:'100%',height:'100%',videoId:'${videoId}',
      playerVars:{playsinline:1,controls:0,cc_load_policy:0,rel:0,fs:0,iv_load_policy:3,disablekb:1,enablejsapi:1,mute:muted?1:0,start:${Math.max(0, Math.floor(init.startSec))},origin:'${PLAYER_ORIGIN}'},
      events:{
        onReady:function(){ready=true;send({t:'ready'});applyMute();apply();setInterval(pollMute,500);},
        onStateChange:function(e){
          if(buffering){
            if(e.data===1){
              buffering=false; buffered=true;
              try{ player.pauseVideo(); player.seekTo(0,true); }catch(_){}
              applyMute(); send({t:'buffered'});
            }
            return;
          }
          // pause — ролик не на экране: играть не даём. hold — его остановил сам человек:
          // запуск кнопкой в плеере — тоже его решение, сообщаем и играем.
          if(e.data===1&&want==='pause'){ try{player.pauseVideo();}catch(_){} return; }
          if(e.data===1&&want==='hold'){ want='play'; send({t:'userplay'}); }
          if(e.data===2&&want==='play'){ want='hold'; send({t:'userpause'}); }
          send({t:'state',s:e.data});
          if(e.data===0&&want==='play'){ send({t:'loop'}); try{player.seekTo(0,true);player.playVideo();}catch(_){} }
          if(e.data===1){
            // Автосубтитры YouTube включает сам (cc_load_policy их не гасит) — модуль выгружаем.
            try{ player.unloadModule('captions'); player.unloadModule('cc'); }catch(_){}
            if(!tick) tick=setInterval(function(){try{send({t:'tick',c:player.getCurrentTime(),d:player.getDuration()});}catch(_){}},1000);
          } else if(tick){ clearInterval(tick); tick=null; }
        },
        onError:function(e){send({t:'error',c:e.data});}
      }});
  };
  var tag=document.createElement('script');
  tag.src='https://www.youtube.com/iframe_api';
  tag.onerror=function(){send({t:'error',c:-1});};
  document.head.appendChild(tag);
})();
</script></body></html>`;
}
