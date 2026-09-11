// =====================================================================
// NEAR-SONIC DATA BEAM — acoustic data transmission over Web Audio API
// =====================================================================

// ---- PROTOCOL CONSTANTS ----
const PREAMBLE_FREQ   = 17500; // Hz — signals "start of transmission"
const BIT0_FREQ       = 18000; // Hz — binary 0
const BIT1_FREQ       = 18500; // Hz — binary 1
const BIT_DURATION    = 0.15;  // seconds per bit (150ms — more margin for timing drift)
const PREAMBLE_DURATION = 0.35; // seconds preamble is held
const FADE_TIME       = 0.005; // seconds, click-avoidance ramp

const FFT_SIZE          = 4096;
const ENERGY_THRESHOLD  = 110;   // 0-255 scale from getByteFrequencyData (lowered for weaker/distant signals)
const CONFIRM_FRAMES    = 4;     // consecutive frames needed to confirm preamble

// ---- DOM REFERENCES ----
const permissionWall   = document.getElementById('permissionWall');
const permissionText   = document.getElementById('permissionText');
const enableMicBtn     = document.getElementById('enableMicBtn');
const mainApp          = document.getElementById('mainApp');

const micStatusDot     = document.getElementById('micStatusDot');
const micStatusText    = document.getElementById('micStatusText');
const audioEngineDot   = document.getElementById('audioEngineDot');
const audioEngineText  = document.getElementById('audioEngineText');

const messageInput     = document.getElementById('messageInput');
const charCount        = document.getElementById('charCount');
const transmitBtn      = document.getElementById('transmitBtn');
const transmitBtnLabel = document.getElementById('transmitBtnLabel');
const testToneBtn      = document.getElementById('testToneBtn');

const waveformCanvas   = document.getElementById('waveformCanvas');
const waveformCtx      = waveformCanvas.getContext('2d');
const messageLog       = document.getElementById('messageLog');
const logEmptyState    = document.getElementById('logEmptyState');
const clearLogBtn      = document.getElementById('clearLogBtn');

const sendTabBtn       = document.getElementById('sendTabBtn');
const receiveTabBtn    = document.getElementById('receiveTabBtn');
const sendPanel        = document.getElementById('sendPanel');
const receivePanel     = document.getElementById('receivePanel');

// ---- TAB SWITCHING ----
function activateTab(tab) {
  const isSend = tab === 'send';
  sendTabBtn.classList.toggle('tab-btn-active', isSend);
  receiveTabBtn.classList.toggle('tab-btn-active', !isSend);
  sendPanel.classList.toggle('hidden', !isSend);
  receivePanel.classList.toggle('hidden', isSend);
}

sendTabBtn.addEventListener('click', () => activateTab('send'));
receiveTabBtn.addEventListener('click', () => activateTab('receive'));

// ---- AUDIO STATE ----
let audioContext = null;
let analyser = null;
let freqData = null;
let binHz = 0; // Hz per FFT bin

// ---- DECODER STATE MACHINE ----
const STATE_IDLE            = 'IDLE';
const STATE_PREAMBLE_ACTIVE = 'PREAMBLE_ACTIVE';
const STATE_READING_LENGTH  = 'READING_LENGTH';
const STATE_READING_MESSAGE = 'READING_MESSAGE';

let decoderState   = STATE_IDLE;
let confirmCounter = 0;
let nextSampleTime = 0;
let bitsBuffer      = [];
let targetBitCount  = 8;
let messageLength   = 0;

// =====================================================================
// A. PERMISSION + AUDIO CONTEXT LIFECYCLE
// =====================================================================

enableMicBtn.addEventListener('click', async () => {
  try {
    // IMPORTANT: disable browser audio processing that's tuned for voice.
    // noiseSuppression/echoCancellation especially tend to filter out
    // non-speech tones like our 17-18.5kHz beam. autoGainControl is kept ON
    // so quieter, distant signals (from another phone) still get boosted
    // enough to cross our detection threshold.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      }
    });

    // Initialize AudioContext immediately (bypasses autoplay restrictions).
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    // Set up analyser for the receiver pipeline.
    analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0; // no lag — we need crisp bit transitions, not smoothed history
    binHz = audioContext.sampleRate / analyser.fftSize;
    freqData = new Uint8Array(analyser.frequencyBinCount);

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser); // do NOT connect analyser to destination (no echo)

    // Update UI: hide permission wall, unlock app.
    permissionWall.style.opacity = '0';
    setTimeout(() => {
      permissionWall.classList.add('hidden');
    }, 400);
    mainApp.classList.remove('hidden');

    setMicStatus(true);
    setAudioEngineStatus(audioContext.state === 'running');

    audioContext.addEventListener('statechange', () => {
      setAudioEngineStatus(audioContext.state === 'running');
    });

    transmitBtn.disabled = false;
    testToneBtn.disabled = false;

    // Kick off the continuous listening/visualizer loop.
    requestAnimationFrame(analysisLoop);

  } catch (err) {
    console.error('Microphone permission error:', err);
    permissionText.classList.add('error');
    permissionText.textContent =
      '⚠️ Permission Denied! To fix this, please click the lock/settings icon next to your URL bar, ' +
      "reset the microphone permission to 'Allow', and refresh this page.";
  }
});

function setMicStatus(active) {
  micStatusDot.classList.toggle('badge-dot-green', active);
  micStatusDot.classList.toggle('badge-dot-red', !active);
  micStatusText.textContent = `Mic Status: ${active ? 'Active' : 'Inactive'}`;
}

function setAudioEngineStatus(ready) {
  audioEngineDot.classList.toggle('badge-dot-green', ready);
  audioEngineDot.classList.toggle('badge-dot-red', !ready);
  audioEngineText.textContent = `Audio Engine: ${ready ? 'Ready' : 'Suspended'}`;
}

// =====================================================================
// B. TRANSMITTER / ENCODER (TEXT -> SOUND)
// =====================================================================

messageInput.addEventListener('input', () => {
  charCount.textContent = messageInput.value.length;
});

transmitBtn.addEventListener('click', async () => {
  const text = messageInput.value;

  if (!text.trim()) {
    alert('Please type a message before transmitting.');
    return;
  }

  if (!audioContext) {
    alert('Audio engine is not ready yet.');
    return;
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const bits = textToBits(text);

  setTransmittingUI(true);
  await playBitSequence(bits);
  setTransmittingUI(false);
});

testToneBtn.addEventListener('click', async () => {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const ctx = audioContext;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1000; // clearly audible reference tone
  osc.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.02);
  gain.gain.setValueAtTime(0.3, now + 0.9);
  gain.gain.linearRampToValueAtTime(0, now + 1.0);

  osc.start(now);
  osc.stop(now + 1.05);
});

function textToBits(text) {
  const bits = [];

  // Length byte first, so the receiver knows exactly how many
  // characters to expect (no silence-detection guesswork).
  const lengthBits = text.length.toString(2).padStart(8, '0').split('');
  bits.push(...lengthBits);

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const charBits = code.toString(2).padStart(8, '0').split('');
    bits.push(...charBits);
  }

  return bits;
}

function playBitSequence(bits) {
  return new Promise((resolve) => {
    const ctx = audioContext;
    const startTime = ctx.currentTime + 0.05; // small safety buffer

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Fade in to avoid a click, then hold on the preamble frequency.
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.8, startTime + FADE_TIME);
    oscillator.frequency.setValueAtTime(PREAMBLE_FREQ, startTime);

    // Schedule each data bit sequentially after the preamble.
    let t = startTime + PREAMBLE_DURATION;
    bits.forEach((bit) => {
      const freq = bit === '1' ? BIT1_FREQ : BIT0_FREQ;
      oscillator.frequency.setValueAtTime(freq, t);
      t += BIT_DURATION;
    });

    // Fade out at the very end.
    gainNode.gain.setValueAtTime(0.8, t - FADE_TIME);
    gainNode.gain.linearRampToValueAtTime(0, t);

    oscillator.start(startTime);
    oscillator.stop(t + 0.02);

    oscillator.onended = () => {
      oscillator.disconnect();
      gainNode.disconnect();
      resolve();
    };
  });
}

function setTransmittingUI(isSending) {
  transmitBtn.disabled = isSending;
  messageInput.disabled = isSending;
  transmitBtn.classList.toggle('transmitting', isSending);
  transmitBtnLabel.textContent = isSending
    ? '📡 Transmitting…'
    : '⚡ Transmit Message via Sound';
}

// =====================================================================
// C. RECEIVER / DECODER (SOUND -> TEXT)
// =====================================================================

function getMagnitudeAtFrequency(freq) {
  const centerBin = Math.round(freq / binHz);
  let sum = 0;
  let count = 0;
  for (let offset = -1; offset <= 1; offset++) {
    const bin = centerBin + offset;
    if (bin >= 0 && bin < freqData.length) {
      sum += freqData[bin];
      count++;
    }
  }
  return count ? sum / count : 0;
}

function analysisLoop(timestampMs) {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);

  drawWaveform();
  runDecoderStep();

  requestAnimationFrame(analysisLoop);
}

function runDecoderStep() {
  const now = performance.now();
  const preambleMag = getMagnitudeAtFrequency(PREAMBLE_FREQ);

  if (decoderState === STATE_IDLE) {
    if (preambleMag > ENERGY_THRESHOLD) {
      confirmCounter++;
      if (confirmCounter >= CONFIRM_FRAMES) {
        decoderState = STATE_PREAMBLE_ACTIVE;
        confirmCounter = 0;
      }
    } else {
      confirmCounter = 0;
    }
    return;
  }

  if (decoderState === STATE_PREAMBLE_ACTIVE) {
    // Wait for the preamble tone to end — that marks the data start.
    if (preambleMag < ENERGY_THRESHOLD) {
      decoderState = STATE_READING_LENGTH;
      bitsBuffer = [];
      targetBitCount = 8;
      // Sample at the center of each upcoming bit window.
      nextSampleTime = now + (BIT_DURATION * 1000) / 2;
    }
    return;
  }

  if (decoderState === STATE_READING_LENGTH || decoderState === STATE_READING_MESSAGE) {
    if (now >= nextSampleTime) {
      const mag0 = getMagnitudeAtFrequency(BIT0_FREQ);
      const mag1 = getMagnitudeAtFrequency(BIT1_FREQ);
      const bit = mag1 > mag0 ? '1' : '0';
      bitsBuffer.push(bit);
      nextSampleTime += BIT_DURATION * 1000;

      if (bitsBuffer.length >= targetBitCount) {
        if (decoderState === STATE_READING_LENGTH) {
          messageLength = parseInt(bitsBuffer.join(''), 2);

          if (!messageLength || messageLength <= 0 || messageLength > 50) {
            // Implausible length — likely a false trigger. Reset.
            resetDecoder();
            return;
          }

          decoderState = STATE_READING_MESSAGE;
          bitsBuffer = [];
          targetBitCount = messageLength * 8;
        } else {
          const text = bitsToText(bitsBuffer);
          appendToLog(text);
          resetDecoder();
        }
      }
    }
  }
}

function bitsToText(bits) {
  let text = '';
  for (let i = 0; i < bits.length; i += 8) {
    const byte = bits.slice(i, i + 8).join('');
    text += String.fromCharCode(parseInt(byte, 2));
  }
  return text;
}

function resetDecoder() {
  decoderState = STATE_IDLE;
  confirmCounter = 0;
  bitsBuffer = [];
  targetBitCount = 8;
}

function appendToLog(text) {
  if (logEmptyState && logEmptyState.parentNode) {
    logEmptyState.remove();
  }

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const timeLabel = document.createElement('span');
  timeLabel.className = 'log-entry-time';
  const now = new Date();
  timeLabel.textContent = now.toLocaleTimeString();

  const body = document.createElement('span');
  body.textContent = text;

  entry.appendChild(timeLabel);
  entry.appendChild(body);
  messageLog.prepend(entry);
}

clearLogBtn.addEventListener('click', () => {
  messageLog.innerHTML = '';
  const empty = document.createElement('p');
  empty.className = 'log-empty';
  empty.id = 'logEmptyState';
  empty.textContent = 'No data beams detected yet... Keep the sender phone close.';
  messageLog.appendChild(empty);
});

// =====================================================================
// WAVEFORM VISUALIZER (17kHz - 19kHz band)
// =====================================================================

function drawWaveform() {
  const width = waveformCanvas.width;
  const height = waveformCanvas.height;
  waveformCtx.clearRect(0, 0, width, height);

  const lowFreq = 17000;
  const highFreq = 19000;
  const lowBin = Math.floor(lowFreq / binHz);
  const highBin = Math.ceil(highFreq / binHz);
  const bandBins = Math.max(1, highBin - lowBin);

  const barCount = 32;
  const binsPerBar = Math.max(1, Math.floor(bandBins / barCount));
  const barWidth = width / barCount;

  for (let i = 0; i < barCount; i++) {
    const startBin = lowBin + i * binsPerBar;
    let sum = 0;
    for (let b = 0; b < binsPerBar; b++) {
      sum += freqData[startBin + b] || 0;
    }
    const avg = sum / binsPerBar;
    const barHeight = Math.max(2, (avg / 255) * height);

    const isHot = avg > ENERGY_THRESHOLD;
    waveformCtx.fillStyle = isHot ? '#10b981' : 'rgba(6, 182, 212, 0.5)';
    waveformCtx.fillRect(
      i * barWidth + 1,
      height - barHeight,
      barWidth - 2,
      barHeight
    );
  }
}
