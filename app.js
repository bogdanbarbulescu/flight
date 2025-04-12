document.addEventListener('DOMContentLoaded', () => {

    // --- Configuration ---
    const ATH_COORDS = [37.9364, 23.9444];
    const OTP_COORDS = [44.5722, 26.1022];
    const WAYPOINTS = [
        { name: "ATH", coords: ATH_COORDS },
        { name: "OTP", coords: OTP_COORDS }
    ];

    // Conversion Factors
    const KTS_TO_KPH = 1.852;
    const FT_TO_M = 0.3048;
    const NM_TO_KM = 1.852;
    const M_TO_FT = 1 / FT_TO_M;
    const KPH_TO_KTS = 1 / KTS_TO_KPH;

    // Initial state (targets are now set from metric sliders later)
    const INITIAL_STATE = {
        lat: ATH_COORDS[0],
        lon: ATH_COORDS[1],
        altitude: 500, // Internal state still in feet
        targetAltitude: 10000, // Internal state still in feet (will be updated from slider)
        speed: 0, // Internal state still in knots
        targetSpeed: 250, // Internal state still in knots (will be updated from slider)
        heading: 0,
        verticalSpeed: 0, // Internal state still in ft/min
        autopilotOn: false,
        currentWaypointIndex: 0,
        simulationTime: 0,
        status: "Idle",
        windSpeed: 15, // Knots
        windDirection: 270
    };
    const SIMULATION_INTERVAL = 100; // ms
    // Physics params remain in standard aviation units (ft, kts)
    const PHYSICS_PARAMS = {
        climbRate: 1800, // ft/min
        descentRate: 1500, // ft/min
        acceleration: 5, // knots/sec
        deceleration: 7, // knots/sec
        turnRate: 3, // degrees/sec
        waypointCaptureDistance: 5, // nautical miles
        landingAltitude: 1000 * FT_TO_M, // Check against altitude in meters (~300m)
        landingSpeed: 140 * KTS_TO_KPH // Check against speed in km/h (~260 km/h)
    };
    // PFD scaling needs adjustment for metric display
    const PFD_PARAMS = {
        // Pixels per unit shown on tape
        speedTapePixelsPerKph: 2 / KTS_TO_KPH, // Adjust base px/kt for km/h
        altitudeTapePixelsPerMeter: 0.1 / FT_TO_M, // Adjust base px/ft for meters
        headingTapePixelsPerDegree: 4, // Stays the same
        // VSI scale: Needs to map m/min range to angle
        vsiMaxRateMetersPerMin: 10, // e.g., +/- 10 m/s * 60 = +/- 600 m/min Max display rate (Adjust VSI marks in HTML too)
        vsiMaxAngle: 45 // degrees deflection for max rate
    };
    const CHART_MAX_POINTS = 100;
    const TAKEOFF_MIN_DIST = 0.1; // NM - Min distance flown before first waypoint sequence allowed


    // --- State ---
    let simState = { ...INITIAL_STATE };
    let simulationTimer = null;
    let totalRouteDistance = 0; // Will store in KM now
    let flownDistance = 0; // Will store in KM now
    let map, plannedRoutePolyline, flownPathPolyline, aircraftMarker;
    let altitudeSpeedChart, forcesChart;
    let chartData = { labels: [], altitude: [], speed: [], lift: [], drag: [], thrust: [] }; // Charts will display metric

    // --- DOM Elements ---
    const bodyElement = document.body;
    const autopilotButton = document.getElementById('autopilot-toggle');
    const resetButton = document.getElementById('reset-button');
    const altitudeSlider = document.getElementById('target-altitude');
    const speedSlider = document.getElementById('target-speed');
    const altitudeValueDisplay = document.getElementById('target-altitude-value');
    const speedValueDisplay = document.getElementById('target-speed-value');
    const infoCard = document.getElementById('info-card');
    const infoCardCloseButton = document.getElementById('info-card-close');
    const infoCardToggle = document.getElementById('info-card-toggle');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    // PFD Elements
    const pfdSpeedValue = document.getElementById('current-speed-value');
    const pfdAltitudeValue = document.getElementById('current-altitude-value');
    const pfdHeadingValue = document.getElementById('current-heading-value');
    const pfdVsiValue = document.getElementById('current-vsi-value');
    const speedScale = document.querySelector('.speed-scale');
    const altitudeScale = document.querySelector('.altitude-scale');
    const headingScale = document.querySelector('.heading-scale');
    const vsiNeedle = document.querySelector('.vsi-needle');
    // Info Card Spans
    const infoStatus = document.getElementById('info-status');
    const infoPosition = document.getElementById('info-position');
    const infoAltitude = document.getElementById('info-altitude');
    const infoSpeed = document.getElementById('info-speed');
    const infoHeading = document.getElementById('info-heading');
    const infoVsi = document.getElementById('info-vsi');
    const infoTotalDist = document.getElementById('info-total-distance');
    const infoFlownDist = document.getElementById('info-flown-distance');
    const infoRemainDist = document.getElementById('info-remaining-distance');
    const infoNextWpt = document.getElementById('info-next-wpt');
    const infoEta = document.getElementById('info-eta');
    const infoWind = document.getElementById('info-wind');


    // --- Initialization ---
    function init() {
        console.log("Initializing Simulator...");
        initDarkMode();
        setupMap();
        setupCharts();
        setupUI(); // Setup UI *after* charts to ensure theme is applied
        calculateTotalRouteDistance(); // Calculates in KM now
        // Set initial simState targets from metric sliders
        handleAltitudeSlider({ target: altitudeSlider });
        handleSpeedSlider({ target: speedSlider });
        resetSimulationState(); // Set initial values correctly AFTER setting targets
        updateUI({ lat: simState.lat, lon: simState.lon }); // Initial UI update based on starting state
        console.log("Simulator Ready.");
    }

    function initDarkMode() {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const savedMode = localStorage.getItem('darkMode');

        if (savedMode === 'enabled' || (!savedMode && prefersDark)) {
            bodyElement.classList.add('dark-mode');
            darkModeToggle.checked = true;
        } else {
            bodyElement.classList.remove('dark-mode');
             darkModeToggle.checked = false;
        }
        // Chart theme update will be called after chart initialization
    }

    function setupMap() {
        map = L.map('map').setView(ATH_COORDS, 7);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles © Esri — Source: Esri, et al.'
        }).addTo(map);
        L.marker(ATH_COORDS, { icon: L.divIcon({ className: 'fa-solid fa-plane-departure fa-2x', iconSize: [20, 20], html: '' }) }).addTo(map).bindPopup("Athens (ATH)");
        L.marker(OTP_COORDS, { icon: L.divIcon({ className: 'fa-solid fa-plane-arrival fa-2x', iconSize: [20, 20], html: '' }) }).addTo(map).bindPopup("Bucharest (OTP)");
        const routePoints = WAYPOINTS.map(wpt => wpt.coords);
        plannedRoutePolyline = L.polyline(routePoints, { color: 'blue', weight: 2, opacity: 0.7, dashArray: '5, 10' }).addTo(map);
        map.fitBounds(plannedRoutePolyline.getBounds().pad(0.1));
        flownPathPolyline = L.polyline([], { color: 'red', weight: 3, opacity: 0.8 }).addTo(map);
        const aircraftIcon = L.divIcon({ html: '<i class="fa-solid fa-plane aircraft-icon"></i>', className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
        aircraftMarker = L.marker(ATH_COORDS, { icon: aircraftIcon, rotationAngle: 0, rotationOrigin: 'center center' }).addTo(map);
    }

    function setupCharts() {
        const commonChartOptions = {
             responsive: true,
             maintainAspectRatio: false,
             animation: false,
             plugins: { legend: { labels: {} } }, // Colors set by theme
             scales: { x: {}, y: {} } // Axis colors set by theme
        };

        const altSpeedCtx = document.getElementById('altitudeSpeedChart').getContext('2d');
        altitudeSpeedChart = new Chart(altSpeedCtx, {
            type: 'line',
            data: { labels: chartData.labels, datasets: [ { label: 'Altitude (m)', data: chartData.altitude, borderColor: 'rgb(75, 192, 192)', tension: 0.1, yAxisID: 'yAltitude' }, { label: 'Speed (km/h)', data: chartData.speed, borderColor: 'rgb(255, 99, 132)', tension: 0.1, yAxisID: 'ySpeed' } ] },
            options: { ...commonChartOptions, scales: { x: { title: { display: true, text: 'Time (s)' } }, yAltitude: { type: 'linear', position: 'left', title: { display: true, text: 'Altitude (m)' }, beginAtZero: true }, ySpeed: { type: 'linear', position: 'right', title: { display: true, text: 'Speed (km/h)' }, beginAtZero: true, grid: { drawOnChartArea: false } } } }
        });

        const forcesCtx = document.getElementById('forcesChart').getContext('2d');
        forcesChart = new Chart(forcesCtx, {
            type: 'line',
            data: { labels: chartData.labels, datasets: [ { label: 'Lift (Conceptual)', data: chartData.lift, borderColor: 'rgb(54, 162, 235)', tension: 0.1 }, { label: 'Drag (Conceptual)', data: chartData.drag, borderColor: 'rgb(255, 159, 64)', tension: 0.1 }, { label: 'Thrust (Conceptual)', data: chartData.thrust, borderColor: 'rgb(153, 102, 255)', tension: 0.1 } ] },
            options: { ...commonChartOptions, scales: { x: { title: { display: true, text: 'Time (s)' } }, y: { title: { display: true, text: 'Relative Force' }, beginAtZero: true, suggestedMax: 1.5 } } }
        });

        updateChartTheme(); // Apply initial theme now charts exist
    }

     function updateChartTheme() {
        const isDarkMode = bodyElement.classList.contains('dark-mode');
        const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        const labelColor = isDarkMode ? 'rgba(255, 255, 255, 0.7)' : '#666';
        const titleColor = isDarkMode ? 'rgba(255, 255, 255, 0.9)' : '#444';

        const updateOptions = (chart) => {
            if (!chart || !chart.options) return;
            chart.options.plugins.legend.labels.color = labelColor;
            Object.keys(chart.options.scales).forEach(axisId => {
                const axis = chart.options.scales[axisId];
                if (axis) {
                    if (axis.ticks) axis.ticks.color = labelColor;
                    if (axis.grid) axis.grid.color = gridColor;
                    if (axis.title) axis.title.color = titleColor;
                }
            });
            chart.update();
        };
        updateOptions(altitudeSpeedChart);
        updateOptions(forcesChart);
    }

    function setupUI() {
        autopilotButton.addEventListener('click', toggleAutopilot);
        resetButton.addEventListener('click', resetSimulation);
        altitudeSlider.addEventListener('input', handleAltitudeSlider);
        speedSlider.addEventListener('input', handleSpeedSlider);
        infoCardCloseButton.addEventListener('click', () => infoCard.classList.add('hidden'));
        infoCardToggle.addEventListener('change', (e) => { infoCard.classList.toggle('hidden', !e.target.checked); });
        darkModeToggle.addEventListener('change', () => {
             bodyElement.classList.toggle('dark-mode');
             localStorage.setItem('darkMode', bodyElement.classList.contains('dark-mode') ? 'enabled' : 'disabled');
             updateChartTheme();
        });

        // Update display values initially from metric sliders
        altitudeValueDisplay.textContent = altitudeSlider.value;
        speedValueDisplay.textContent = speedSlider.value;
    }

    function resetSimulationState() {
         // Set internal state based on current slider values (converting from metric)
         simState = { ...INITIAL_STATE,
             targetAltitude: parseFloat(altitudeSlider.value) * M_TO_FT, // Convert slider meters to internal feet
             targetSpeed: parseFloat(speedSlider.value) * KPH_TO_KTS,   // Convert slider km/h to internal knots
             altitude: 500, // Reset internal feet
             speed: 0,      // Reset internal knots
             verticalSpeed: 0,
             heading: 0, // Reset heading - calculate based on route later
             currentWaypointIndex: 0,
             simulationTime: 0,
             status: "Idle",
             windSpeed: Math.round(Math.random() * 30), // knots
             windDirection: Math.round(Math.random() * 360)
         };
         flownDistance = 0; // Reset KM

         // Reset map elements
         if (aircraftMarker) aircraftMarker.setLatLng(ATH_COORDS);
         if (aircraftMarker) aircraftMarker.setRotationAngle(0); // Face North initially
         if (flownPathPolyline) flownPathPolyline.setLatLngs([]);
         if (map) map.setView(ATH_COORDS, 10);

         // Reset charts
         chartData = { labels: [], altitude: [], speed: [], lift: [], drag: [], thrust: [] };
         if (altitudeSpeedChart) { altitudeSpeedChart.data = { ...altitudeSpeedChart.data, labels: chartData.labels, datasets: [ {...altitudeSpeedChart.data.datasets[0], data: chartData.altitude}, {...altitudeSpeedChart.data.datasets[1], data: chartData.speed} ]}; altitudeSpeedChart.update('none'); }
         if (forcesChart) { forcesChart.data = { ...forcesChart.data, labels: chartData.labels, datasets: [ {...forcesChart.data.datasets[0], data: chartData.lift}, {...forcesChart.data.datasets[1], data: chartData.drag}, {...forcesChart.data.datasets[2], data: chartData.thrust} ]}; forcesChart.update('none'); }

         // Reset UI State
         simState.autopilotOn = false;
         stopSimulation(); // Ensure timer is stopped
         updateUI({ lat: simState.lat, lon: simState.lon }); // Update display based on reset state
     }

    // --- Simulation Loop ---
    function simulationLoop() {
        if (!simState.autopilotOn || simState.status === "Landed") return;

        const dt = SIMULATION_INTERVAL / 1000; // seconds
        simState.simulationTime += dt;

        // Update Internal State (using feet, knots)
        updateAltitude(dt);
        updateSpeed(dt);
        updateHeading(dt);
        const { groundSpeed, track } = calculateWindEffect(simState.heading, simState.speed, simState.windDirection, simState.windSpeed); // GS is in knots
        updatePosition(dt, groundSpeed, track); // groundSpeed in kts, track in degrees

        const currentPos = { lat: simState.lat, lon: simState.lon };
        updateFlownDistance(currentPos); // Updates flownDistance in KM

        // Check Conditions
        checkLanding(); // Checks using metric units defined in PHYSICS_PARAMS

        // Update UI (displaying metric units)
        updateUI(currentPos, groundSpeed); // Pass GS (knots) for ETA calc

        // Check Waypoint Arrival (AFTER position update)
        checkWaypointArrival();
    }

    // --- Core Logic (Internal units: ft, kts, ft/min) ---
    function updateAltitude(dt) {
        const altDiffFt = simState.targetAltitude - simState.altitude; // Difference in feet
        const climbRateFtMin = PHYSICS_PARAMS.climbRate;
        const descentRateFtMin = PHYSICS_PARAMS.descentRate;
        let verticalSpeedFtMin = 0;

        if (Math.abs(altDiffFt) > 10) { // Tolerance in feet (~3 meters)
            if (altDiffFt > 0) {
                verticalSpeedFtMin = Math.min(climbRateFtMin, (altDiffFt / dt) * 60);
            } else {
                verticalSpeedFtMin = Math.max(-descentRateFtMin, (altDiffFt / dt) * 60);
            }
            simState.altitude += (verticalSpeedFtMin / 60) * dt; // Apply change in feet
        }
        simState.verticalSpeed = Math.round(verticalSpeedFtMin); // Store internal VSI in ft/min
        simState.altitude = Math.max(0, simState.altitude); // Don't go below 0 feet
    }

    function updateSpeed(dt) {
        const speedDiffKts = simState.targetSpeed - simState.speed; // Difference in knots
        const accelKtsSec = PHYSICS_PARAMS.acceleration;
        const decelKtsSec = PHYSICS_PARAMS.deceleration;
        let speedChangeKts = 0;

        if (Math.abs(speedDiffKts) > 1) { // Tolerance in knots
             if (speedDiffKts > 0) {
                speedChangeKts = Math.min(accelKtsSec * dt, speedDiffKts);
            } else {
                speedChangeKts = Math.max(-decelKtsSec * dt, speedDiffKts);
            }
            simState.speed += speedChangeKts; // Apply change in knots
        }
        simState.speed = Math.max(0, simState.speed); // Don't go below 0 knots
    }

    function updateHeading(dt) {
        if (simState.currentWaypointIndex >= WAYPOINTS.length) return;

        const currentPos = { lat: simState.lat, lon: simState.lon };
        const targetWptCoords = WAYPOINTS[simState.currentWaypointIndex].coords;
        const targetBearing = getBearing(currentPos.lat, currentPos.lon, targetWptCoords[0], targetWptCoords[1]);

        let headingDiff = targetBearing - simState.heading;
        if (headingDiff > 180) headingDiff -= 360;
        if (headingDiff <= -180) headingDiff += 360;

        const turnAmount = PHYSICS_PARAMS.turnRate * dt; // Turn rate in degrees

        if (Math.abs(headingDiff) < turnAmount) {
            simState.heading = targetBearing;
        } else if (headingDiff > 0) {
            simState.heading += turnAmount;
        } else {
            simState.heading -= turnAmount;
        }
        simState.heading = (simState.heading + 360) % 360;
    }

    function calculateWindEffect(heading, airspeedKnots, windDirection, windSpeedKnots) {
        // Calculation remains the same, inputs/outputs are knots & degrees
        const headingRad = degreesToRadians(heading);
        const windDirRad = degreesToRadians(windDirection);
        const Vax = airspeedKnots * Math.sin(headingRad);
        const Vay = airspeedKnots * Math.cos(headingRad);
        const Wx = windSpeedKnots * Math.sin(windDirRad);
        const Wy = windSpeedKnots * Math.cos(windDirRad);
        const Gx = Vax + Wx;
        const Gy = Vay + Wy;
        const groundSpeedKnots = Math.sqrt(Gx * Gx + Gy * Gy);
        let track = radiansToDegrees(Math.atan2(Gx, Gy));
        track = (track + 360) % 360;
        return { groundSpeed: groundSpeedKnots, track: track }; // Return knots
    }

    function updatePosition(dt, groundSpeedKnots, track) {
        const distanceNM = groundSpeedKnots * (dt / 3600);
        if (distanceNM <= 0) return;
        const newCoords = calculateNewPosition(simState.lat, simState.lon, track, distanceNM);
        simState.lat = newCoords.lat;
        simState.lon = newCoords.lon;
    }

     function updateFlownDistance(currentPos) {
         if (flownPathPolyline) {
             flownPathPolyline.addLatLng([currentPos.lat, currentPos.lon]);
             const pathPoints = flownPathPolyline.getLatLngs();
             if (pathPoints.length > 1) {
                 const prevPoint = pathPoints[pathPoints.length - 2];
                 // getDistance returns NM, convert to KM for storage/display
                 const distanceIncrementNM = getDistance(prevPoint.lat, prevPoint.lng, currentPos.lat, currentPos.lon);
                 flownDistance += distanceIncrementNM * NM_TO_KM; // Add KM
             }
         }
     }

    // --- **** IMPROVED CIRCLING FIX APPLIED HERE **** ---
    function checkWaypointArrival() {
        if (simState.currentWaypointIndex >= WAYPOINTS.length) return; // Past last waypoint

        const targetWptCoords = WAYPOINTS[simState.currentWaypointIndex].coords;
        // getDistance returns NM
        const distanceToWaypointNM = getDistance(simState.lat, simState.lon, targetWptCoords[0], targetWptCoords[1]);

        // Check if close enough
        if (distanceToWaypointNM < PHYSICS_PARAMS.waypointCaptureDistance) {

            // **** SPECIAL CHECK FOR FIRST WAYPOINT (ATH) ****
            // Only sequence past the *first* waypoint if we've actually moved away from it
            if (simState.currentWaypointIndex === 0 && flownDistance < TAKEOFF_MIN_DIST) {
                 console.log("Holding at first waypoint until minimum distance flown.");
                 return; // Don't sequence yet
            }
            // **** END SPECIAL CHECK ****

            // Now, normal sequencing logic
            if (simState.currentWaypointIndex < WAYPOINTS.length - 1) {
                 console.log(`Arrived at intermediate waypoint ${WAYPOINTS[simState.currentWaypointIndex].name}`);
                 simState.currentWaypointIndex++;
                 simState.status = "En Route";
                 console.log(`Now heading to ${WAYPOINTS[simState.currentWaypointIndex].name}`);
            } else {
                 console.log(`Reached Final Waypoint: ${WAYPOINTS[simState.currentWaypointIndex].name}`);
                 simState.status = "Approaching";
                 // Do not increment index, keep targeting final WPT
            }
        }
    }
     // --- **** END IMPROVED CIRCLING FIX **** ---


    function checkLanding() {
        // Check only when targeting the final waypoint
        if (simState.currentWaypointIndex === WAYPOINTS.length - 1) {
            const distanceToOTPNM = getDistance(simState.lat, simState.lon, OTP_COORDS[0], OTP_COORDS[1]);
            const currentAltitudeM = simState.altitude * FT_TO_M; // Current altitude in meters
            const currentSpeedKph = simState.speed * KTS_TO_KPH; // Current speed in km/h

            // Check for approach status
            if (distanceToOTPNM < PHYSICS_PARAMS.waypointCaptureDistance * 2 &&
                currentAltitudeM > PHYSICS_PARAMS.landingAltitude && // Still above landing check alt
                simState.status !== "Landed" && simState.status !== "Approaching") {
                console.log("Approaching final destination area.");
                simState.status = "Approaching";
            }

            // Check for landing conditions (using METRIC thresholds from PHYSICS_PARAMS)
            if (distanceToOTPNM < 2 * NM_TO_KM && currentAltitudeM < PHYSICS_PARAMS.landingAltitude) { // Check distance < 2km approx
                if (simState.status !== "Landing Soon" && simState.status !== "Landed") {
                    console.log("Close to ground near destination, checking landing speed.");
                    simState.status = "Landing Soon";
                }

                if (currentSpeedKph < PHYSICS_PARAMS.landingSpeed && currentAltitudeM < 30) { // ~30m altitude for touchdown
                   if (simState.status !== "Landed") {
                        console.log("Landed!");
                        simState.status = "Landed";
                        simState.autopilotOn = false;
                        stopSimulation();
                   }
                }
            }
        }
    }

    // --- UI Update Functions (Display Metric) ---
    function updateUI(currentPos, groundSpeedKnots = 0) {
        if (aircraftMarker) {
            aircraftMarker.setLatLng([currentPos.lat, currentPos.lon]);
            aircraftMarker.setRotationAngle(simState.heading);
        }
        updatePFDDisplay(); // Displays metric
        updateInfoCard(groundSpeedKnots); // Displays metric, needs GS in knots for ETA calc
        updateCharts(); // Displays metric
    }

    function updatePFDDisplay() {
        const speedKph = simState.speed * KTS_TO_KPH;
        const altitudeM = simState.altitude * FT_TO_M;
        const verticalSpeedMps = (simState.verticalSpeed / 60) * FT_TO_M; // ft/min -> ft/s -> m/s
        const verticalSpeedMpm = verticalSpeedMps * 60; // m/min

        // Speed Tape (km/h)
        pfdSpeedValue.textContent = Math.round(speedKph);
        const speedOffset = -(speedKph * PFD_PARAMS.speedTapePixelsPerKph);
        if(speedScale) speedScale.style.transform = `translateY(${speedOffset}px)`;

        // Altitude Tape (m)
        pfdAltitudeValue.textContent = Math.round(altitudeM);
        const altitudeOffset = altitudeM * PFD_PARAMS.altitudeTapePixelsPerMeter;
         if(altitudeScale) altitudeScale.style.transform = `translateY(${altitudeOffset}px)`;

        // Heading Tape (degrees)
        pfdHeadingValue.textContent = Math.round(simState.heading).toString().padStart(3, '0');
        const headingOffset = -(simState.heading * PFD_PARAMS.headingTapePixelsPerDegree);
         if(headingScale) headingScale.style.transform = `translateX(${headingOffset}px)`;

        // VSI (m/min) - Scale marks in HTML need updating to match m/min range
        pfdVsiValue.textContent = Math.round(verticalSpeedMpm);
        // Clamp VSI rate based on meters per minute max display rate
        const vsiRateClamped = Math.max(-PFD_PARAMS.vsiMaxRateMetersPerMin, Math.min(PFD_PARAMS.vsiMaxRateMetersPerMin, verticalSpeedMpm));
        const vsiAngle = (vsiRateClamped / PFD_PARAMS.vsiMaxRateMetersPerMin) * PFD_PARAMS.vsiMaxAngle;
         if(vsiNeedle) vsiNeedle.style.transform = `translateY(-50%) rotate(${vsiAngle}deg)`;
    }

    function updateInfoCard(groundSpeedKnots) {
        // Convert internal state to metric for display
        const altitudeM = simState.altitude * FT_TO_M;
        const groundSpeedKph = groundSpeedKnots * KTS_TO_KPH;
        const verticalSpeedMpm = (simState.verticalSpeed / 60) * FT_TO_M * 60; // ft/min -> m/min
        const windSpeedKph = simState.windSpeed * KTS_TO_KPH;
        const remainingDistanceKm = Math.max(0, totalRouteDistance - flownDistance); // Already in KM

        infoStatus.textContent = simState.status;
        infoPosition.textContent = `${simState.lat.toFixed(4)} N, ${simState.lon.toFixed(4)} E`;
        infoAltitude.textContent = `${Math.round(altitudeM)}`; // Unit is in HTML
        infoSpeed.textContent = `${Math.round(groundSpeedKph)}`; // Unit is in HTML
        infoHeading.textContent = `${Math.round(simState.heading)}`; // Unit is in HTML
        infoVsi.textContent = `${Math.round(verticalSpeedMpm)}`; // Unit is in HTML

        infoTotalDist.textContent = `${totalRouteDistance.toFixed(1)}`; // Unit is in HTML
        infoFlownDist.textContent = `${flownDistance.toFixed(1)}`; // Unit is in HTML
        infoRemainDist.textContent = `${remainingDistanceKm.toFixed(1)}`; // Unit is in HTML

        if (simState.currentWaypointIndex < WAYPOINTS.length) {
            infoNextWpt.textContent = WAYPOINTS[simState.currentWaypointIndex].name;
        } else if (simState.status === "Landed") {
             infoNextWpt.textContent = "Arrived";
        } else {
             infoNextWpt.textContent = "Destination";
        }

        // ETA calculation using Ground Speed in KPH and Remaining Distance in KM
        let etaString = "--:--:--";
        if (groundSpeedKph > 20 && remainingDistanceKm > 0 && simState.status !== "Landed" && simState.status !== "Landing Soon") {
            const timeHours = remainingDistanceKm / groundSpeedKph;
            const totalSeconds = Math.round(timeHours * 3600);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            etaString = `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
        } else if (simState.status === "Landed") {
             etaString = "Arrived";
        }
        infoEta.textContent = etaString;

        infoWind.textContent = `${Math.round(simState.windDirection)}° @ ${Math.round(windSpeedKph)} km/h`;
    }

    function updateCharts() {
         if (!altitudeSpeedChart || !forcesChart) return;

         // Add METRIC data to charts
         const altitudeM = simState.altitude * FT_TO_M;
         const speedKph = simState.speed * KTS_TO_KPH;

         // Conceptual forces based on internal speed (knots) relative to target
         const lift = Math.pow(simState.speed / simState.targetSpeed, 2); // Relative lift
         const drag = lift * 0.8 + 0.1;
         let thrust = 0.5;
         if (simState.speed < simState.targetSpeed) thrust = 1.0;
         if (simState.altitude < simState.targetAltitude) thrust = 1.2; // More thrust if climbing
         if (simState.speed > simState.targetSpeed) thrust = 0.2;

         chartData.labels.push(Math.round(simState.simulationTime));
         chartData.altitude.push(Math.round(altitudeM)); // Add meters
         chartData.speed.push(Math.round(speedKph));    // Add km/h
         chartData.lift.push(lift.toFixed(2));
         chartData.drag.push(drag.toFixed(2));
         chartData.thrust.push(thrust.toFixed(2));

         // Limit data points
         if (chartData.labels.length > CHART_MAX_POINTS) {
             chartData.labels.shift(); chartData.altitude.shift(); chartData.speed.shift();
             chartData.lift.shift(); chartData.drag.shift(); chartData.thrust.shift();
         }

         altitudeSpeedChart.update('none');
         forcesChart.update('none');
    }


    // --- Event Handlers ---
    function toggleAutopilot() {
         if (simState.status === "Landed") return;
         simState.autopilotOn = !simState.autopilotOn;
         if (simState.autopilotOn) { startSimulation(); }
         else { stopSimulation(); }
    }

     function resetSimulation() {
         stopSimulation();
         resetSimulationState();
         console.log("Simulation Reset");
     }

    function handleAltitudeSlider(event) {
        const targetMeters = parseInt(event.target.value);
        simState.targetAltitude = targetMeters * M_TO_FT; // Convert slider meters to internal feet target
        altitudeValueDisplay.textContent = targetMeters; // Display selected meters
        console.log(`Target Altitude set to: ${targetMeters} m (${simState.targetAltitude.toFixed(0)} ft)`);
    }

    function handleSpeedSlider(event) {
        const targetKph = parseInt(event.target.value);
        simState.targetSpeed = targetKph * KPH_TO_KTS; // Convert slider km/h to internal knots target
        speedValueDisplay.textContent = targetKph; // Display selected km/h
         console.log(`Target Speed set to: ${targetKph} km/h (${simState.targetSpeed.toFixed(0)} kts)`);
    }

     function updateAutopilotButtonState() {
         // Logic remains the same, controls button text/state/colors
         if (simState.autopilotOn) {
             autopilotButton.innerHTML = '<i class="fa-solid fa-pause"></i> Disengage Autopilot';
             autopilotButton.classList.remove('btn-primary'); autopilotButton.classList.add('btn-warning');
             autopilotButton.disabled = false; resetButton.disabled = true;
         } else {
             autopilotButton.innerHTML = '<i class="fa-solid fa-play"></i> Engage Autopilot';
             autopilotButton.classList.remove('btn-warning'); autopilotButton.classList.add('btn-primary');
             autopilotButton.disabled = simState.status === "Landed"; // Disable engage if landed
             resetButton.disabled = false;
         }
     }

    // --- Simulation Control ---
    function startSimulation() {
        if (!simulationTimer && simState.status !== "Landed") {
            // Set initial status correctly based on internal altitude (feet)
            simState.status = simState.altitude < 1000 ? "Takeoff / Climb" : "En Route";
            console.log("Autopilot Engaged - Status:", simState.status);
            updateInfoCard(simState.speed); // Update card immediately
            simulationTimer = setInterval(simulationLoop, SIMULATION_INTERVAL);
            updateAutopilotButtonState();
        }
    }

    function stopSimulation() {
        if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
        if (simState.status !== "Landed") { // Don't overwrite "Landed"
            simState.autopilotOn = false;
            simState.status = "Paused";
             console.log("Autopilot Disengaged - Status:", simState.status);
        }
        updateAutopilotButtonState();
        updateInfoCard(simState.speed); // Update card immediately
    }

    // --- Helper Functions (Unchanged: degreesToRadians, radiansToDegrees) ---
    function degreesToRadians(degrees) { return degrees * Math.PI / 180; }
    function radiansToDegrees(radians) { return radians * 180 / Math.PI; }

    // --- Helper Functions (Updated: getDistance returns NM, calculateTotalRouteDistance uses KM) ---
    function getDistance(lat1, lon1, lat2, lon2) {
        // Returns distance in Nautical Miles (NM)
        const R = 6371 / NM_TO_KM; // Earth radius in NM
        const dLat = degreesToRadians(lat2 - lat1); const dLon = degreesToRadians(lon2 - lon1);
        lat1 = degreesToRadians(lat1); lat2 = degreesToRadians(lat2);
        const a = Math.sin(dLat / 2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2)**2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c; // Distance in NM
    }

    function getBearing(lat1, lon1, lat2, lon2) { /* Unchanged */ return (radiansToDegrees(Math.atan2(Math.sin(degreesToRadians(lon2 - lon1)) * Math.cos(degreesToRadians(lat2)), Math.cos(degreesToRadians(lat1)) * Math.sin(degreesToRadians(lat2)) - Math.sin(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2)) * Math.cos(degreesToRadians(lon2 - lon1)))) + 360) % 360; }
    function calculateNewPosition(lat, lon, bearing, distanceNM) { /* Unchanged, uses NM */ const R=6371/NM_TO_KM; const φ1=degreesToRadians(lat); const λ1=degreesToRadians(lon); const brng=degreesToRadians(bearing); const d=distanceNM; const φ2=Math.asin(Math.sin(φ1)*Math.cos(d/R)+Math.cos(φ1)*Math.sin(d/R)*Math.cos(brng)); let λ2=λ1+Math.atan2(Math.sin(brng)*Math.sin(d/R)*Math.cos(φ1),Math.cos(d/R)-Math.sin(φ1)*Math.sin(φ2)); const lat2_deg=radiansToDegrees(φ2); let lon2_deg=radiansToDegrees(λ2); if(lon2_deg>180){lon2_deg-=360;}else if(lon2_deg<=-180){lon2_deg+=360;} return{lat:lat2_deg,lon:lon2_deg}; }


     function calculateTotalRouteDistance() {
         totalRouteDistance = 0; // Store in KM
         for (let i = 0; i < WAYPOINTS.length - 1; i++) {
             // getDistance returns NM, convert to KM
             totalRouteDistance += getDistance(
                 WAYPOINTS[i].coords[0], WAYPOINTS[i].coords[1],
                 WAYPOINTS[i+1].coords[0], WAYPOINTS[i+1].coords[1]
             ) * NM_TO_KM;
         }
         console.log(`Total route distance: ${totalRouteDistance.toFixed(1)} km`);
     }


    // --- Start Initialization ---
    init();

}); // End DOMContentLoaded