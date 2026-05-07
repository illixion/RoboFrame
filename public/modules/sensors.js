// Home Assistant sensor pane (top-right). The server forwards entity state
// changes via the `update` action; we pretty-print them into #sensors.

import { params } from './config.js';

export function hassioUpdate(payload) {
    if (!params.ws) return;
    const stateInfo = {
        entity: payload.entity,
        state: payload.state,
        friendly_name: payload.attributes && payload.attributes.friendly_name,
        unit: payload.attributes && payload.attributes.unit_of_measurement,
    };
    if (!stateInfo.friendly_name) return;

    const sensors = document.getElementById('sensors');
    if (!sensors) return;
    let sensor = sensors.querySelector(`div[data-entity="${stateInfo.entity}"]`);

    stateInfo.friendly_name = stateInfo.friendly_name
        .replace('Temperature', '🌡️')
        .replace('Humidity', '💧')
        .replace('Atmospheric pressure', '🌬️');

    if (stateInfo.state !== 'unavailable' && stateInfo.unit !== 'unavailable') {
        if (sensor) {
            sensor.textContent = `${stateInfo.friendly_name}: ${stateInfo.state}${stateInfo.unit}`;
            sensor.dataset.lastKnownState = `${stateInfo.state}${stateInfo.unit}`;
        } else {
            const newSensor = document.createElement('div');
            newSensor.textContent = `${stateInfo.friendly_name}: ${stateInfo.state}${stateInfo.unit}`;
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
        sensor.textContent = `❗ ${stateInfo.friendly_name}: ${lastKnownState}`;
    }

    const stripNonAscii = (str) => (str || '').replace(/[^\x20-\x7E]/g, '');
    Array.from(sensors.children).sort((a, b) =>
        stripNonAscii(a.dataset.friendlyName).localeCompare(stripNonAscii(b.dataset.friendlyName))
    );
}
