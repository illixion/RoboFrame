// Home Assistant sensor pane (top-right). The server forwards entity state
// changes via the `update` action; we pretty-print them into #sensors.

import { params } from './config.js';

// An emoji for the kind of reading: HA's device_class, else a unit only one
// kind of sensor uses. A bare % says nothing (humidity, battery, ...), so it
// never picks one. Same rules as RoboFrameKit's RoboFrameSensorReading.emoji
// and native-kiosk's sensor_emoji.
const CLASS_EMOJI = {
    temperature: '🌡️',
    humidity: '💧',
    pressure: '🌬️',
    atmospheric_pressure: '🌬️',
};
const UNIT_EMOJI = {
    '°C': '🌡️', '°F': '🌡️', K: '🌡️',
    hPa: '🌬️', mbar: '🌬️', kPa: '🌬️', inHg: '🌬️', mmHg: '🌬️',
};

function sensorEmoji(deviceClass, unit) {
    if (deviceClass) return CLASS_EMOJI[deviceClass] || '';
    return UNIT_EMOJI[unit] || '';
}

export function hassioUpdate(payload) {
    if (!params.ws) return;
    const stateInfo = {
        entity: payload.entity,
        state: payload.state,
        friendly_name: payload.attributes && payload.attributes.friendly_name,
        unit: payload.attributes && payload.attributes.unit_of_measurement,
        device_class: payload.attributes && payload.attributes.device_class,
    };
    if (!stateInfo.friendly_name) return;

    const sensors = document.getElementById('sensors');
    if (!sensors) return;
    let sensor = sensors.querySelector(`div[data-entity="${stateInfo.entity}"]`);

    const emoji = sensorEmoji(stateInfo.device_class, stateInfo.unit);
    const label = emoji ? `${stateInfo.friendly_name} ${emoji}` : stateInfo.friendly_name;

    if (stateInfo.state !== 'unavailable' && stateInfo.unit !== 'unavailable') {
        if (sensor) {
            sensor.textContent = `${label}: ${stateInfo.state}${stateInfo.unit}`;
            sensor.dataset.lastKnownState = `${stateInfo.state}${stateInfo.unit}`;
        } else {
            const newSensor = document.createElement('div');
            newSensor.textContent = `${label}: ${stateInfo.state}${stateInfo.unit}`;
            newSensor.dataset.entity = stateInfo.entity;
            newSensor.dataset.friendlyName = stateInfo.friendly_name;
            newSensor.dataset.lastKnownState = `${stateInfo.state}${stateInfo.unit}`;
            sensors.appendChild(newSensor);
        }
    } else {
        if (!sensor) {
            sensor = document.createElement('div');
            sensor.dataset.entity = stateInfo.entity;
            sensor.dataset.friendlyName = stateInfo.friendly_name;
            sensors.appendChild(sensor);
        }
        const lastKnownState = sensor.dataset.lastKnownState || 'N/A';
        sensor.textContent = `❗ ${label}: ${lastKnownState}`;
    }

    const stripNonAscii = (str) => (str || '').replace(/[^\x20-\x7E]/g, '');
    Array.from(sensors.children).sort((a, b) =>
        stripNonAscii(a.dataset.friendlyName).localeCompare(stripNonAscii(b.dataset.friendlyName))
    );
}
