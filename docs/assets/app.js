(() => {
  'use strict';

  const config = window.SATFINDER_CONFIG || {};
  const elements = {
    networkState: document.querySelector('.network-state'),
    networkStateText: document.querySelector('#networkState'),
    lastUpdated: document.querySelector('#lastUpdated'),
    projectSubtitle: document.querySelector('#projectSubtitle'),
    refreshButton: document.querySelector('#refreshButton'),
    stationSearch: document.querySelector('#stationSearch'),
    statusFilters: document.querySelector('#statusFilters'),
    stationList: document.querySelector('#stationList'),
    resultCount: document.querySelector('#resultCount'),
    errorBanner: document.querySelector('#errorBanner'),
    errorMessage: document.querySelector('#errorMessage'),
    selectionCard: document.querySelector('#selectionCard'),
    closeSelection: document.querySelector('#closeSelection'),
    selectedStatus: document.querySelector('#selectedStatus'),
    selectedName: document.querySelector('#selectedName'),
    selectedRegion: document.querySelector('#selectedRegion'),
    selectedConfirmed: document.querySelector('#selectedConfirmed'),
    selectedTelemetry: document.querySelector('#selectedTelemetry'),
    selectedSeen: document.querySelector('#selectedSeen'),
    metricTotal: document.querySelector('#metricTotal'),
    metricLatest: document.querySelector('#metricLatest'),
    metricOnline: document.querySelector('#metricOnline'),
    metricOnlineRate: document.querySelector('#metricOnlineRate'),
    metricFollowup: document.querySelector('#metricFollowup'),
    metricPackets: document.querySelector('#metricPackets'),
    metricTelemetry: document.querySelector('#metricTelemetry'),
  };

  const state = {
    data: null,
    activeFilter: 'all',
    query: '',
    selectedKey: '',
    loading: false,
    requestId: 0,
  };

  const numberFormatter = new Intl.NumberFormat('th-TH');
  const percentFormatter = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
  const relativeFormatter = new Intl.RelativeTimeFormat('th', { numeric: 'auto' });
  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  });

  const statusLabels = {
    online: 'ออนไลน์',
    recent: 'เพิ่งพบสัญญาณ',
    followup: 'รอติดตาม',
  };
  const markerColors = {
    online: '#5ff0ad',
    recent: '#67d9f3',
    followup: '#f2c14e',
  };

  let map;
  let stationLayer;
  const markersByKey = new Map();

  function initializeMap() {
    if (!window.L) throw new Error('โหลดระบบแผนที่ไม่สำเร็จ');
    map = window.L.map('map', {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 2,
      worldCopyJump: true,
    }).setView(config.defaultCenter || [13.7563, 100.5018], config.defaultZoom || 5);
    window.L.control.zoom({ position: 'bottomleft' }).addTo(map);
    window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);
    stationLayer = window.L.layerGroup().addTo(map);
  }

  function loadJsonp(url, timeoutMs = 25_000) {
    return new Promise((resolve, reject) => {
      const callback = `__satfinder_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
      const separator = url.includes('?') ? '&' : '?';
      const cleanup = () => {
        clearTimeout(timer);
        script.remove();
        delete window[callback];
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('หมดเวลารอข้อมูลจาก Google Sheets'));
      }, timeoutMs);

      window[callback] = (payload) => {
        cleanup();
        resolve(payload);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error('เชื่อมต่อ Apps Script endpoint ไม่สำเร็จ'));
      };
      script.src = `${url}${separator}callback=${encodeURIComponent(callback)}&_=${Date.now()}`;
      script.async = true;
      document.head.append(script);
    });
  }

  function formatNumber(value) {
    return numberFormatter.format(Number(value) || 0);
  }

  function formatRelative(minutes) {
    const numeric = Number(minutes);
    if (!Number.isFinite(numeric)) return 'ไม่พบเวลา';
    if (numeric < 60) return relativeFormatter.format(-Math.max(0, Math.round(numeric)), 'minute');
    if (numeric < 1440) return relativeFormatter.format(-Math.round(numeric / 60), 'hour');
    return relativeFormatter.format(-Math.round(numeric / 1440), 'day');
  }

  function statusLabel(stateName) {
    return statusLabels[stateName] || 'ไม่ระบุสถานะ';
  }

  function normalizedSearch(value) {
    return String(value || '').trim().toLocaleLowerCase('th');
  }

  function filteredStations() {
    if (!state.data) return [];
    return state.data.stations.filter((station) => {
      if (state.activeFilter !== 'all' && station.monitorState !== state.activeFilter) return false;
      if (!state.query) return true;
      const haystack = [station.name, station.satellite, station.satDisplayName, station.region, station.version]
        .map(normalizedSearch)
        .join(' ');
      return haystack.includes(state.query);
    });
  }

  function createText(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function popupContent(station) {
    const wrapper = document.createElement('div');
    wrapper.append(
      createText('div', 'popup-status', statusLabel(station.monitorState)),
      createText('div', 'popup-name', station.name),
      createText('div', 'popup-meta', `${station.region || 'ไม่ระบุพื้นที่'} · ${station.satellite || 'ไม่ระบุดาวเทียม'}`),
    );
    return wrapper;
  }

  function renderMap(stations) {
    stationLayer.clearLayers();
    markersByKey.clear();
    const bounds = [];
    for (const station of stations) {
      const latitude = Number(station.latitude);
      const longitude = Number(station.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const color = markerColors[station.monitorState] || '#91a99f';
      const marker = window.L.circleMarker([latitude, longitude], {
        radius: station.monitorState === 'online' ? 7 : 5.5,
        weight: 1.5,
        color,
        fillColor: color,
        fillOpacity: station.monitorState === 'online' ? 0.88 : 0.68,
      });
      marker.bindPopup(popupContent(station), { className: 'station-popup', closeButton: false });
      marker.on('click', () => selectStation(station.stationKey, false));
      marker.addTo(stationLayer);
      markersByKey.set(station.stationKey, marker);
      bounds.push([latitude, longitude]);
    }
    if (bounds.length && !state.selectedKey) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 8 });
    }
  }

  function createStationButton(station) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `station-item${state.selectedKey === station.stationKey ? ' is-selected' : ''}`;
    button.dataset.key = station.stationKey;
    button.dataset.state = station.monitorState;
    button.setAttribute('aria-label', `${station.name}, ${statusLabel(station.monitorState)}`);
    button.addEventListener('click', () => selectStation(station.stationKey, true));

    const signal = createText('span', 'station-signal', '');
    signal.setAttribute('aria-hidden', 'true');
    const copy = createText('span', 'station-copy', '');
    copy.append(
      createText('strong', '', station.name),
      createText('span', '', `${station.region || 'ไม่ระบุพื้นที่'} · ${station.satellite || 'ไม่ระบุดาวเทียม'} · ${formatRelative(station.minutesSinceSeen)}`),
    );
    const packets = createText('span', 'station-packets', '');
    packets.append(
      createText('strong', '', formatNumber(station.confirmedPackets)),
      createText('small', '', 'confirmed'),
    );
    button.append(signal, copy, packets);
    return button;
  }

  function renderStationList(stations) {
    elements.stationList.replaceChildren();
    elements.resultCount.textContent = `${formatNumber(stations.length)} สถานี`;
    if (!stations.length) {
      const empty = createText('div', 'empty-state', 'ไม่พบสถานีที่ตรงกับตัวกรอง');
      elements.stationList.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    stations.forEach((station) => fragment.append(createStationButton(station)));
    elements.stationList.append(fragment);
  }

  function renderMetrics(summary) {
    const total = Number(summary.totalStations) || 0;
    const online = Number(summary.onlineStations) || 0;
    elements.metricTotal.textContent = formatNumber(total);
    elements.metricLatest.textContent = `${formatNumber(summary.latestStations)} สถานีในข้อมูลรอบล่าสุด`;
    elements.metricOnline.textContent = formatNumber(online);
    elements.metricOnlineRate.textContent = `${percentFormatter.format(total ? online / total * 100 : 0)}% ของเครือข่าย`;
    elements.metricFollowup.textContent = formatNumber(summary.followUpStations);
    elements.metricPackets.textContent = formatNumber(summary.confirmedPackets);
    elements.metricTelemetry.textContent = `${formatNumber(summary.telemetryPackets)} telemetry`;
  }

  function renderFilters() {
    const stations = filteredStations();
    renderStationList(stations);
    renderMap(stations);
  }

  function selectedStation() {
    return state.data?.stations.find((station) => station.stationKey === state.selectedKey);
  }

  function selectStation(stationKey, moveMap) {
    state.selectedKey = stationKey;
    const station = selectedStation();
    if (!station) return closeSelection();
    elements.selectionCard.hidden = false;
    elements.selectedStatus.textContent = statusLabel(station.monitorState);
    elements.selectedName.textContent = station.name;
    elements.selectedRegion.textContent = `${station.region || 'ไม่ระบุพื้นที่'} · ${station.satellite || 'ไม่ระบุดาวเทียม'}`;
    elements.selectedConfirmed.textContent = formatNumber(station.confirmedPackets);
    elements.selectedTelemetry.textContent = formatNumber(station.telemetryPackets);
    elements.selectedSeen.textContent = formatRelative(station.minutesSinceSeen);
    document.querySelectorAll('.station-item').forEach((item) => {
      item.classList.toggle('is-selected', item.dataset.key === stationKey);
    });
    const marker = markersByKey.get(stationKey);
    if (marker) {
      if (moveMap) map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 8), { duration: 0.6 });
      marker.openPopup();
    }
  }

  function closeSelection() {
    state.selectedKey = '';
    elements.selectionCard.hidden = true;
    map.closePopup();
    document.querySelectorAll('.station-item.is-selected').forEach((item) => item.classList.remove('is-selected'));
  }

  function showError(error) {
    elements.networkState.classList.remove('is-live');
    elements.networkState.classList.add('is-error');
    elements.networkStateText.textContent = 'การเชื่อมต่อมีปัญหา';
    elements.errorMessage.textContent = error.message || 'โปรดลองใหม่อีกครั้ง';
    elements.errorBanner.hidden = false;
  }

  function showLive(importDate) {
    elements.networkState.classList.remove('is-error');
    elements.networkState.classList.add('is-live');
    elements.networkStateText.textContent = 'เชื่อมต่อ Google Sheets แล้ว';
    elements.lastUpdated.dateTime = importDate?.toISOString() || '';
    elements.lastUpdated.textContent = importDate ? `ข้อมูล ${dateFormatter.format(importDate)}` : '';
    elements.errorBanner.hidden = true;
  }

  async function refreshData() {
    if (state.loading || !config.apiUrl) return;
    state.loading = true;
    state.requestId += 1;
    const requestId = state.requestId;
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add('is-loading');
    elements.networkStateText.textContent = 'กำลังอัปเดตข้อมูล';
    try {
      const payload = await loadJsonp(config.apiUrl);
      if (requestId !== state.requestId) return;
      if (!payload?.ok || !payload?.data || !Array.isArray(payload.data.stations)) {
        throw new Error('รูปแบบข้อมูลจาก Apps Script ไม่ถูกต้อง');
      }
      state.data = payload.data;
      renderMetrics(payload.data.summary || {});
      renderFilters();
      const project = payload.data.project || {};
      elements.projectSubtitle.textContent = `${project.operatorName || 'SatFinder'} · ${project.countryFocus || 'Thailand'}`;
      const importDate = payload.data.config?.lastImportAt ? new Date(payload.data.config.lastImportAt) : null;
      showLive(importDate && !Number.isNaN(importDate.getTime()) ? importDate : null);
    } catch (error) {
      showError(error);
      if (!state.data) {
        elements.stationList.replaceChildren(createText('div', 'empty-state', 'ยังไม่มีข้อมูลสถานีให้แสดง'));
      }
    } finally {
      state.loading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.classList.remove('is-loading');
    }
  }

  elements.refreshButton.addEventListener('click', refreshData);
  elements.closeSelection.addEventListener('click', closeSelection);
  elements.stationSearch.addEventListener('input', (event) => {
    state.query = normalizedSearch(event.target.value);
    closeSelection();
    renderFilters();
  });
  elements.statusFilters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.activeFilter = button.dataset.filter;
    elements.statusFilters.querySelectorAll('button').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
    });
    closeSelection();
    renderFilters();
  });

  try {
    initializeMap();
    refreshData();
    window.setInterval(refreshData, Math.max(30_000, Number(config.refreshIntervalMs) || 60_000));
  } catch (error) {
    showError(error);
  }
})();
