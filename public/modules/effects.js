// RPC-driven UI overlays — video, audio, full-screen text, live scenes.
// These are pushed over WebSocket via `playVideo`, `stopVideo`, `showText`,
// `dismissText`, `stopAudio`, `playScene`, `stopScene` actions and rendered
// on top of the slideshow.

import { disable } from './visibility.js';

let videoContainer = null;
let currentVideoElement = null;
let currentAudioElement = null;
let textContainer = null;
let sceneContainer = null;
let scenePc = null;
let sceneSession = null;   // WHEP resource URL for the DELETE teardown

export function playVideo(url) {
    stopVideo();
    videoContainer = document.createElement('div');
    videoContainer.className = 'rpc-video-container';
    const videoElement = document.createElement('video');
    videoElement.src = url;
    videoElement.autoplay = true;
    videoElement.controls = false;
    videoElement.loop = false;
    videoElement.className = 'rpc-video-element';
    currentVideoElement = videoElement;
    videoContainer.appendChild(videoElement);
    document.body.appendChild(videoContainer);
    videoElement.addEventListener('ended', () => stopVideo());
    disable(true);
}

export function stopVideo() {
    if (currentVideoElement) {
        currentVideoElement.pause();
        currentVideoElement = null;
    }
    if (videoContainer) {
        videoContainer.remove();
        videoContainer = null;
    }
    disable(false);
}

// Live scene: a server-rendered effect page streamed as WebRTC video. The
// payload's `whep` URL points at a mediamtx WHEP endpoint (credentials, if
// any, travel as query params on that URL). Muted video only — scenes are
// ambient content, same tier as playVideo.
export async function playScene(whepUrl) {
    stopScene();
    const pc = new RTCPeerConnection({ iceServers: [] });   // LAN: host candidates suffice
    scenePc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });

    sceneContainer = document.createElement('div');
    sceneContainer.className = 'rpc-video-container';
    const videoElement = document.createElement('video');
    videoElement.autoplay = true;
    videoElement.muted = true;
    videoElement.playsInline = true;
    videoElement.controls = false;
    videoElement.className = 'rpc-video-element';
    sceneContainer.appendChild(videoElement);
    document.body.appendChild(sceneContainer);
    pc.ontrack = (ev) => { videoElement.srcObject = ev.streams[0]; };
    disable(true);

    try {
        // WHEP without trickle: gather all host candidates, then POST the
        // complete offer. On a LAN gathering completes in milliseconds.
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve();
            pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') resolve();
            });
            setTimeout(resolve, 2000);   // safety: POST what we have
        });
        const resp = await fetch(whepUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: pc.localDescription.sdp,
        });
        if (!resp.ok) throw new Error(`WHEP subscribe failed: HTTP ${resp.status}`);
        const loc = resp.headers.get('Location');
        if (loc) sceneSession = new URL(loc, whepUrl).href;
        await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
    } catch (err) {
        console.error('playScene:', err);
        stopScene();
    }
}

export function stopScene() {
    if (sceneSession) {
        fetch(sceneSession, { method: 'DELETE' }).catch(() => {});
        sceneSession = null;
    }
    if (scenePc) {
        scenePc.close();
        scenePc = null;
    }
    if (sceneContainer) {
        sceneContainer.remove();
        sceneContainer = null;
    }
    disable(false);
}

export function playAudio(url) {
    stopAudio();
    const audioElement = document.createElement('audio');
    audioElement.preload = 'metadata';
    audioElement.autoplay = true;
    audioElement.loop = false;
    audioElement.style.display = 'none';
    currentAudioElement = audioElement;
    document.body.appendChild(audioElement);

    // 30s safety net — keeps the web client's behaviour aligned with
    // the spatialstash side (visionOS SystemSound APIs hard-cap at 30s)
    // and stops a long stream from monopolising the page accidentally.
    audioElement.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audioElement.duration) && audioElement.duration > 30) {
            console.warn(`playAudio: clip duration ${audioElement.duration.toFixed(1)}s > 30s, ignoring`);
            stopAudio();
        }
    });
    audioElement.addEventListener('ended', () => stopAudio());

    audioElement.src = url;
}

export function stopAudio() {
    if (currentAudioElement) {
        currentAudioElement.pause();
        currentAudioElement.remove();
        currentAudioElement = null;
    }
}

export function showText(text, bgColorHex = '#000000', imageUrl = '') {
    dismissText();
    textContainer = document.createElement('div');
    textContainer.className = 'rpc-text-container';
    textContainer.style.backgroundColor = bgColorHex;

    if (imageUrl) {
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = 'Centered Image';
        textContainer.appendChild(img);
    }

    const textElement = document.createElement('div');
    textElement.textContent = text;
    textElement.className = 'rpc-text-element';
    textContainer.appendChild(textElement);
    document.body.appendChild(textContainer);

    function resizeText() {
        let fontSize = window.innerHeight;
        textElement.style.fontSize = `${fontSize}px`;
        while ((textElement.scrollWidth > textContainer.clientWidth || textElement.scrollHeight > textContainer.clientHeight) && fontSize > 1) {
            fontSize -= 1;
            textElement.style.fontSize = `${fontSize}px`;
        }
        textElement.style.fontSize = `${fontSize - 1}px`;
    }
    resizeText();
    window.addEventListener('resize', resizeText);
    disable(true);
}

export function dismissText() {
    if (textContainer) {
        textContainer.remove();
        textContainer = null;
    }
    disable(false);
}
