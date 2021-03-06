var bbox = require('@turf/bbox');
var area = require('@turf/area');
var inside = require('@turf/inside');
var helpers = require('@turf/helpers');
var explode = require('@turf/explode');
var invariant = require('@turf/invariant');
var gridToMatrix = require('grid-to-matrix');
var marchingsquares = require('marchingsquares');
var polygon = helpers.polygon;
var multiPolygon = helpers.multiPolygon;
var collectionOf = invariant.collectionOf;
var featureCollection = helpers.featureCollection;

/**
 * Takes a grid {@link FeatureCollection} of {@link Point} features with z-values and an array of
 * value breaks and generates filled contour isobands.
 *
 * @name isobands
 * @param {FeatureCollection<Point>} pointGrid input points
 * @param {Array<number>} breaks where to draw contours
 * @param {string} [zProperty='elevation'] the property name in `points` from which z-values will be pulled
 * @param {Object} [options={}] options on output
 * @param {Array<Object>} [options.isobandProperties=[]] GeoJSON properties passed, in order, to the correspondent isoband (order defined by breaks)
 * @param {Object} [options.commonProperties={}] GeoJSON properties passed to ALL isobands
 * @returns {FeatureCollection<MultiPolygon>} a FeatureCollection of {@link MultiPolygon} features representing isobands
 * @example
 * // create a grid of points with random z-values in their properties
 * var extent = [-70.823364, -33.553984, -69.823364, -32.553984];
 * var cellWidth = 5;
 * var units = 'miles';
 * var pointGrid = turf.pointGrid(extent, cellWidth, units);
 * for (var i = 0; i < pointGrid.features.length; i++) {
 *     pointGrid.features[i].properties.elevation = Math.random() * 10;
 * }
 * var breaks = [0, 5, 8.5];
 *
 * var isobands = turf.isobands(pointGrid, breaks);
 *
 * //addToMap
 * var addToMap = [isobands];
 */
module.exports = function (pointGrid, breaks, zProperty, options) {
    // Input validation
    var isObject = function (input) {
        return (!!input) && (input.constructor === Object);
    };
    collectionOf(pointGrid, 'Point', 'Input must contain Points');
    if (!breaks || !Array.isArray(breaks)) throw new Error('breaks is required');
    options = options || {};
    if (options.commonProperties && !isObject(options.commonProperties)) {
        throw new Error('commonProperties is not an Object');
    }
    if (options.isobandProperties && !Array.isArray(options.isobandProperties)) {
        throw new Error('isobandProperties is not an Array');
    }
    if (zProperty && typeof zProperty !== 'string') { throw new Error('zProperty is not a string'); }

    zProperty = zProperty || 'elevation';
    var commonProperties = options.commonProperties || {};
    var isobandProperties = options.isobandProperties || [];

    // Isoband methods
    var matrix = gridToMatrix(pointGrid, zProperty, true);
    var contours = createContourLines(matrix, breaks, zProperty);
    contours = rescaleContours(contours, matrix, pointGrid);

    var multipolygons = contours.map(function (contour, index) {
        if (isobandProperties[index] && !isObject(isobandProperties[index])) {
            throw new Error('Each mappedProperty is required to be an Object');
        }
        // collect all properties
        var contourProperties = Object.assign(
            {},
            commonProperties,
            isobandProperties[index]
        );
        contourProperties[zProperty] = contour[zProperty];
        var multiP = multiPolygon(contour.groupedRings, contourProperties);
        return multiP;
    });

    return featureCollection(multipolygons);
};

/**
 * Creates the contours lines (featuresCollection of polygon features) from the 2D data grid
 *
 * Marchingsquares process the grid data as a 3D representation of a function on a 2D plane, therefore it
 * assumes the points (x-y coordinates) are one 'unit' distance. The result of the IsoBands function needs to be
 * rescaled, with turfjs, to the original area and proportions on the map
 *
 * @private
 * @param {Array<Array<number>>} matrix Grid Data
 * @param {Array<number>} breaks Breaks
 * @param {string} [property='elevation'] Property
 * @returns {Array<any>} contours
 */
function createContourLines(matrix, breaks, property) {

    var contours = [];
    for (var i = 1; i < breaks.length; i++) {
        var lowerBand = +breaks[i - 1]; // make sure the breaks value is a number
        var upperBand = +breaks[i];

        var isobandsCoords = marchingsquares.isoBands(matrix, lowerBand, upperBand - lowerBand);
        // as per GeoJson rules for creating a Polygon, make sure the first element
        // in the array of LinearRings represents the exterior ring (i.e. biggest area),
        // and any subsequent elements represent interior rings (i.e. smaller area);
        // this avoids rendering issues of the MultiPolygons on the map
        var nestedRings = orderByArea(isobandsCoords);
        var groupedRings = groupNestedRings(nestedRings);
        var obj = {};
        obj['groupedRings'] = groupedRings;
        obj[property] = lowerBand + '-' + upperBand;
        contours.push(obj);
    }
    return contours;
}

/**
 * Transform isobands of 2D grid to polygons for the map
 *
 * @private
 * @param {Array<any>} contours Contours
 * @param {Array<Array<number>>} matrix Grid Data
 * @param {Object} points Points by Latitude
 * @returns {Array<any>} contours
 */
function rescaleContours(contours, matrix, points) {

    // get dimensions (on the map) of the original grid
    var gridBbox = bbox(points); // [ minX, minY, maxX, maxY ]
    var originalWidth = gridBbox[2] - gridBbox[0];
    var originalHeigth = gridBbox[3] - gridBbox[1];

    // get origin, which is the first point of the last row on the rectangular data on the map
    var x0 = gridBbox[0];
    var y0 = gridBbox[1];
    // get number of cells per side
    var matrixWidth = matrix[0].length - 1;
    var matrixHeight = matrix.length - 1;
    // calculate the scaling factor between matrix and rectangular grid on the map
    var scaleX = originalWidth / matrixWidth;
    var scaleY = originalHeigth / matrixHeight;

    var resize = function (point) {
        point[0] = point[0] * scaleX + x0;
        point[1] = point[1] * scaleY + y0;
    };

    // resize and shift each point/line of the isobands
    contours.forEach(function (contour) {
        contour.groupedRings.forEach(function (lineRingSet) {
            lineRingSet.forEach(function (lineRing) {
                lineRing.forEach(resize);
            });
        });
    });
    return contours;
}


/*  utility functions */


/**
 * Returns an array of coordinates (of LinearRings) in descending order by area
 *
 * @private
 * @param {Array<LineString>} ringsCoords array of closed LineString
 * @returns {Array} array of the input LineString ordered by area
 */
function orderByArea(ringsCoords) {
    var ringsWithArea = [];
    var areas = [];
    ringsCoords.forEach(function (coords) {
        // var poly = polygon([points]);
        var ringArea = area(polygon([coords]));
        // create an array of areas value
        areas.push(ringArea);
        // associate each lineRing with its area
        ringsWithArea.push({ring: coords, area: ringArea});
    });
    areas.sort(function (a, b) { // bigger --> smaller
        return b - a;
    });
    // create a new array of linearRings coordinates ordered by their area
    var orderedByArea = [];
    areas.forEach(function (area) {
        for (var lr = 0; lr < ringsWithArea.length; lr++) {
            if (ringsWithArea[lr].area === area) {
                orderedByArea.push(ringsWithArea[lr].ring);
                ringsWithArea.splice(lr, 1);
                break;
            }
        }
    });
    return orderedByArea;
}

/**
 * Returns an array of arrays of coordinates, each representing
 * a set of (coordinates of) nested LinearRings,
 * i.e. the first ring contains all the others
 *
 * @private
 * @param {Array} orderedLinearRings array of coordinates (of LinearRings) in descending order by area
 * @returns {Array<Array>} Array of coordinates of nested LinearRings
 */
function groupNestedRings(orderedLinearRings) {
    // create a list of the (coordinates of) LinearRings
    var lrList = orderedLinearRings.map(function (lr) {
        return {lrCoordinates: lr, grouped: false};
    });
    var groupedLinearRingsCoords = [];
    while (!allGrouped(lrList)) {
        for (var i = 0; i < lrList.length; i++) {
            if (!lrList[i].grouped) {
                // create new group starting with the larger not already grouped ring
                var group = [];
                group.push(lrList[i].lrCoordinates);
                lrList[i].grouped = true;
                var outerMostPoly = polygon([lrList[i].lrCoordinates]);
                // group all the rings contained by the outermost ring
                for (var j = i + 1; j < lrList.length; j++) {
                    if (!lrList[j].grouped) {
                        var lrPoly = polygon([lrList[j].lrCoordinates]);
                        if (isInside(lrPoly, outerMostPoly)) {
                            group.push(lrList[j].lrCoordinates);
                            lrList[j].grouped = true;
                        }
                    }
                }
                // insert the new group
                groupedLinearRingsCoords.push(group);
            }
        }
    }
    return groupedLinearRingsCoords;
}

/**
 * @private
 * @param {Polygon} testPolygon polygon of interest
 * @param {Polygon} targetPolygon polygon you want to compare with
 * @returns {boolean} true if test-Polygon is inside target-Polygon
 */
function isInside(testPolygon, targetPolygon) {
    var points = explode(testPolygon);
    for (var i = 0; i < points.features.length; i++) {
        if (!inside(points.features[i], targetPolygon)) {
            return false;
        }
    }
    return true;
}

/**
 * @private
 * @param {Array<Object>} list list of objects which might contain the 'group' attribute
 * @returns {boolean} true if all the objects in the list are marked as grouped
 */
function allGrouped(list) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].grouped === false) {
            return false;
        }
    }
    return true;
}
