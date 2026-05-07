// RPC-driven UI overlays — video, audio, full-screen text. These are pushed
// over WebSocket via `playVideo`, `stopVideo`, `showText`, `dismissText`,
// `stopAudio` actions and rendered on top of the slideshow.

import { disable } from './visibility.js';

let videoContainer = null;
let currentVideoElement = null;
let currentAudioElement = null;
let textContainer = null;

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
