/* wren-voice.js — Reusable voice recorder + transcription component
 * Usage: WrenVoice.attachTo(textareaEl, { context: 'observation' })
 */
(function (global) {
  'use strict';

  let activeRecorder = null;

  const WrenVoice = {
    attachTo(textarea, opts) {
      if (!textarea) return;
      opts = opts || {};
      const context = opts.context || null;

      // Wrap textarea in a relative container so we can position the button
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;display:flex;align-items:flex-start;gap:8px;';
      textarea.parentNode.insertBefore(wrap, textarea);
      wrap.appendChild(textarea);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wren-mic-btn';
      btn.title = 'Voice input';
      btn.innerHTML = '🎙️';
      btn.style.cssText = [
        'flex-shrink:0',
        'width:40px',
        'height:40px',
        'border-radius:50%',
        'border:2px solid var(--c-border,#2d3748)',
        'background:var(--c-card,#1e293b)',
        'color:var(--c-text,#f1f5f9)',
        'font-size:18px',
        'cursor:pointer',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'transition:all 0.2s ease',
        'margin-top:2px',
      ].join(';');

      wrap.appendChild(btn);

      let recording = false;
      let chunks = [];
      let mediaRecorder = null;
      let statusEl = null;

      function setRecordingUI(on) {
        recording = on;
        if (on) {
          btn.innerHTML = '⏹️';
          btn.style.background = 'rgba(239,68,68,0.2)';
          btn.style.borderColor = '#ef4444';
          btn.style.animation = 'wren-mic-pulse 1s ease-in-out infinite';
          if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.style.cssText = 'font-size:12px;color:#ef4444;margin-top:4px;';
            statusEl.textContent = '● Recording…';
            wrap.after(statusEl);
          }
        } else {
          btn.innerHTML = '🎙️';
          btn.style.background = 'var(--c-card,#1e293b)';
          btn.style.borderColor = 'var(--c-border,#2d3748)';
          btn.style.animation = '';
          if (statusEl) { statusEl.remove(); statusEl = null; }
        }
      }

      async function startRecording() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          Wren && Wren.toast ? Wren.toast('Voice input not supported in this browser', 'warning')
            : alert('Voice input not supported');
          return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          chunks = [];

          // Prefer webm/opus; fall back to whatever the browser supports
          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
              ? 'audio/ogg;codecs=opus'
              : '';

          mediaRecorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);

          mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
          mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
            sendForTranscription(blob, mediaRecorder.mimeType);
          };

          mediaRecorder.start();
          setRecordingUI(true);
          activeRecorder = mediaRecorder;

          // Auto-stop at 60s
          setTimeout(() => { if (recording) stopRecording(); }, 60000);
        } catch (err) {
          if (err.name === 'NotAllowedError') {
            Wren && Wren.toast ? Wren.toast('Microphone permission denied', 'error') : alert('Microphone permission denied');
          } else {
            Wren && Wren.toast ? Wren.toast('Could not access microphone', 'error') : alert('Could not access microphone');
          }
        }
      }

      function stopRecording() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
          setRecordingUI(false);
          activeRecorder = null;
          if (statusEl) { statusEl.textContent = '⏳ Transcribing…'; statusEl.style.color = '#4a9abf'; }
        }
      }

      async function sendForTranscription(blob, mimeType) {
        const tempStatus = document.createElement('div');
        tempStatus.style.cssText = 'font-size:12px;color:#4a9abf;margin-top:4px;';
        tempStatus.textContent = '⏳ Transcribing…';
        wrap.after(tempStatus);

        try {
          const ext = mimeType && mimeType.includes('ogg') ? 'ogg' : 'webm';
          const fd = new FormData();
          fd.append('audio', blob, `recording.${ext}`);
          if (context) fd.append('context', context);

          const token = sessionStorage.getItem('wrenToken') || sessionStorage.getItem('wren_token') || sessionStorage.getItem('wren_jwt') || '';
          const resp = await fetch('/api/transcribe', {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: fd,
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${resp.status}`);
          }

          const data = await resp.json();
          if (data.text) {
            const cur = textarea.value;
            textarea.value = cur ? cur + ' ' + data.text : data.text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            Wren && Wren.toast && Wren.toast('Transcribed ✓', 'success');
            tempStatus.textContent = '✓ Done';
            setTimeout(() => tempStatus.remove(), 2000);
          } else {
            throw new Error('No text returned');
          }
        } catch (e) {
          console.error('[wren-voice] transcribe error:', e);
          tempStatus.textContent = '⚠ Transcription failed';
          tempStatus.style.color = '#ef4444';
          setTimeout(() => tempStatus.remove(), 4000);
          Wren && Wren.toast && Wren.toast('Transcription failed: ' + e.message, 'error');
        }
      }

      btn.addEventListener('click', () => {
        if (!recording) {
          startRecording();
        } else {
          stopRecording();
        }
      });

      // Inject pulse animation once
      if (!document.getElementById('wren-voice-styles')) {
        const style = document.createElement('style');
        style.id = 'wren-voice-styles';
        style.textContent = `
          @keyframes wren-mic-pulse {
            0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
            50% { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
          }
        `;
        document.head.appendChild(style);
      }

      return { btn, stop: stopRecording };
    },
  };

  global.WrenVoice = WrenVoice;
})(window);
