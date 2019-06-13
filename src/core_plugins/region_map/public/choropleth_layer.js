/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import $ from 'jquery';
import L from 'leaflet';
import _ from 'lodash';
import d3 from 'd3';
import { KibanaMapLayer } from 'ui/vis/map/kibana_map_layer';
import { truncatedColorMaps } from 'ui/vislib/components/color/truncated_colormaps';
import * as topojson from 'topojson-client';
import { toastNotifications } from 'ui/notify';
import * as colorUtil from 'ui/vis/map/color_util';

const EMPTY_STYLE = {
  weight: 1,
  opacity: 0.6,
  color: 'rgb(200,200,200)',
  fillOpacity: 0
};

const LINE_TYPE = ['LineString', 'MultiLineString'];


export default class ChoroplethLayer extends KibanaMapLayer {

  constructor(geojsonUrl, attribution, format, showAllShapes, meta, features, featureDict, toRender) {
    super();

    this._metrics = null;
    this._joinField = null;
    this._colorRamp = truncatedColorMaps[Object.keys(truncatedColorMaps)[0]];
    this._lineWeight = 1;
    this._tooltipFormatter = () => '';
    this._attribution = attribution;
    this._boundsOfData = null;
    this._featureCollection = features;
    this._featureDict = featureDict;
    this._toRender = toRender;
    this._prevKeys = [];

    this._showAllShapes = showAllShapes;
    this._geojsonUrl = geojsonUrl;

    this._leafletLayer = L.geoJson(null, {
      onEachFeature: (feature, layer) => {
        layer.on('click', () => {
          this.emit('select', feature.properties[this._joinField]);
        });
        let location = null;
        layer.on({
          mouseover: () => {
            const tooltipContents = this._tooltipFormatter(feature);
            if (!location) {
              const leafletGeojson = L.geoJson(feature);
              location = leafletGeojson.getBounds().getCenter();
            }
            this.emit('showTooltip', {
              content: tooltipContents,
              position: location
            });
          },
          mouseout: () => {
            this.emit('hideTooltip');
          }
        });
      },
      style: this._makeEmptyStyleFunction()
    });

    this._loaded = false;
    this._error = false;
    this._isJoinValid = false;
    this._whenDataLoaded = new Promise(async (resolve) => {
      try {
        let featureCollection;
        if (this._featureCollection.length === 0) {
          const data = await this._makeJsonAjaxCall(geojsonUrl);
          const formatType = typeof format === 'string' ? format : format.type;
          if (formatType === 'geojson') {
            featureCollection = data;
          } else if (formatType === 'topojson') {
            const features = _.get(data, 'objects.' + meta.feature_collection_path);
            featureCollection = topojson.feature(data, features);//conversion to geojson
          } else {
            //should never happen
            throw new Error('Unrecognized format ' + formatType);
          }

          this._featureCollection = featureCollection.features.slice();
          this._setFeatureDict();
        }

        this._loaded = true;
        this._setStyle();
        resolve();
      } catch (e) {
        console.log(e);
        this._loaded = true;
        this._error = true;

        let errorMessage;
        if (e.status === 404) {
          errorMessage = `Server responding with '404' when attempting to fetch ${geojsonUrl}.
                          Make sure the file exists at that location.`;
        } else {
          errorMessage = `Cannot download ${geojsonUrl} file. Please ensure the
CORS configuration of the server permits requests from the Kibana application on this host.`;
        }

        toastNotifications.addDanger({
          title: 'Error downloading vector data',
          text: errorMessage,
        });

        resolve();
      }
    });

  }

  //This method is stubbed in the tests to avoid network request during unit tests.
  async _makeJsonAjaxCall(url) {
    return await $.ajax({
      dataType: 'json',
      url: url
    });
  }

  _invalidateJoin() {
    this._isJoinValid = false;
  }

  _clearPrevFeatures() {
    if (this._featureDict) {
      this._prevKeys.forEach(key => this._featureDict[key].__kbnJoinedMetric = null);
      this._prevKeys = [];
    }
  }

  _innerJoin() {
    this._clearPrevFeatures();
    if (!this._metrics) return [[], []];
    const featuresToDraw = [];
    const mismatchedKeys = [];
    for (let i = this._metrics.length - 1; i >= 0; i--) {
      const keyTerm = this._metrics[i].term;
      const _feature = this._featureDict[keyTerm];
      if (_feature) {
        _feature.__kbnJoinedMetric = this._metrics[i];
        featuresToDraw.push(_feature);
        this._prevKeys.push(keyTerm);
      } else {
        mismatchedKeys.push(keyTerm);
      }
    }
    this._isJoinValid = true;
    return [featuresToDraw, mismatchedKeys];
  }

  _leftOuterJoin() {
    this._featureCollection.forEach(_feature => _feature.__kbnJoinedMetric = null);
    const mismatchedKeys = [];
    for (let i = 0; i < this._metrics.length; i++) {
      const keyTerm = this._metrics[i].term;
      const _feature = this._featureDict[keyTerm];
      if (_feature) {
        _feature.__kbnJoinedMetric = this._metrics[i];
      } else {
        mismatchedKeys.push(keyTerm);
      }
    }
    this._isJoinValid = true;
    return [this._featureCollection, mismatchedKeys];
  }


  _setStyle() {
    if (this._error || (!this._loaded || !this._metrics || !this._joinField || !this._toRender)) {
      return;
    }

    let joinResult = [[], []];
    if (!this._isJoinValid) {
      if (this._showAllShapes) {
        joinResult = this._leftOuterJoin();
      } else {
        joinResult = this._innerJoin();
      }
      const featureCollection = {
        type: 'FeatureCollection',
        features: joinResult[0]
      };
      this._leafletLayer.addData(featureCollection);
    }

    const styler = this._makeChoroplethStyler();
    this._leafletLayer.setStyle(styler.leafletStyleFunction);

    if (this._metrics && this._metrics.length > 0) {
      const { min, max } = getMinMax(this._metrics);
      this._legendColors = colorUtil.getLegendColors(this._colorRamp);
      const quantizeDomain = (min !== max) ? [min, max] : d3.scale.quantize().domain();
      this._legendQuantizer = d3.scale.quantize().domain(quantizeDomain).range(this._legendColors);
    }
    this._boundsOfData = styler.getLeafletBounds();
    this.emit('styleChanged', {
      mismatches: joinResult[1]
    });
  }

  getUrl() {
    return this._geojsonUrl;
  }

  setTooltipFormatter(tooltipFormatter, metricsAgg, fieldName) {
    this._tooltipFormatter = (geojsonFeature) => {
      if (!this._metrics) {
        return '';
      }
      const match = this._metrics.find((bucket) => {
        return compareLexicographically(bucket.term, geojsonFeature.properties[this._joinField]) === 0;
      });
      return tooltipFormatter(metricsAgg, match, fieldName);
    };
  }

  setJoinField(joinfield) {
    if (joinfield === this._joinField) {
      return;
    }
    this._joinField = joinfield;
    this._setFeatureDict();
    this._setStyle();
  }

  _setFeatureDict() {
    if (!this._joinField) return;
    if (!this._featureCollection) return;
    this._featureDict = {};
    for (let i = 0; i < this._featureCollection.length; i++) {
      const _feature = this._featureCollection[i];
      this._featureDict[_feature.properties[this._joinField]] = _feature;
    }
    this._invalidateJoin();
  }

  cloneChoroplethLayerForNewData(url, attribution, format, showAllData, meta, toRender) {
    let features = [];
    let featureDict = {};
    if ((url === this._geojsonUrl) && (this._featureCollection) && (this._featureDict)) {
      features = this._featureCollection;
      featureDict = this._featureDict;
      this._clearPrevFeatures();
    }
    const clonedLayer = new ChoroplethLayer(url, attribution, format, showAllData, meta, features, featureDict, toRender);
    clonedLayer.setJoinField(this._joinField);
    clonedLayer.setColorRamp(this._colorRamp);
    clonedLayer.setLineWeight(this._lineWeight);
    clonedLayer.setTooltipFormatter(this._tooltipFormatter);
    if (this._metrics && this._metricsAgg) {
      clonedLayer.setMetrics(this._metrics, this._metricsAgg);
    }
    clonedLayer.enableRendering();
    return clonedLayer;
  }

  whenDataLoaded() {
    return this._whenDataLoaded;
  }

  setMetrics(metrics, metricsAgg) {
    this._metrics = metrics.slice();

    this._metricsAgg = metricsAgg;
    this._valueFormatter = this._metricsAgg.fieldFormatter();

    this._invalidateJoin();
    this._setStyle();
  }


  setColorRamp(colorRamp) {
    if (_.isEqual(colorRamp, this._colorRamp)) {
      return;
    }
    this._colorRamp = colorRamp;
    this._setStyle();
  }

  setLineWeight(lineWeight) {
    if (this._lineWeight === lineWeight) {
      return;
    }
    this._lineWeight = lineWeight;
    this._setStyle();
  }

  canReuseInstance(geojsonUrl, showAllShapes) {
    return this._geojsonUrl === geojsonUrl && this._showAllShapes === showAllShapes;
  }

  canReuseInstanceForNewMetrics(geojsonUrl, showAllShapes, newMetrics) {
    if (this._geojsonUrl !== geojsonUrl) {
      return false;
    }

    if (showAllShapes) {
      return this._showAllShapes === showAllShapes;
    }

    if (!this._metrics) {
      return;
    }

    const currentKeys = this._metrics.map(bucket => bucket.term);
    const newKeys = newMetrics.map(bucket => bucket.term);
    return _.isEqual(currentKeys, newKeys);
  }

  getBounds() {
    const bounds = super.getBounds();
    return (this._boundsOfData) ? this._boundsOfData : bounds;
  }

  appendLegendContents(jqueryDiv) {

    if (!this._legendColors || !this._legendQuantizer || !this._metricsAgg) {
      return;
    }

    const titleText = this._metricsAgg.makeLabel();
    const $title = $('<div>').addClass('visMapLegend__title').text(titleText);
    jqueryDiv.append($title);

    this._legendColors.forEach((color) => {

      const labelText = this._legendQuantizer
        .invertExtent(color)
        .map(this._valueFormatter)
        .join(' – ');

      const label = $('<div>');
      const icon = $('<i>').css({
        background: color,
        'border-color': makeColorDarker(color)
      });

      const text = $('<span>').text(labelText);
      label.append(icon);
      label.append(text);

      jqueryDiv.append(label);
    });
  }

  disableRendering() {
    this._toRender = false;
  }
  enableRendering() {
    this._toRender = true;
  }


  _makeEmptyStyleFunction() {

    const emptyStyle = _.assign({}, EMPTY_STYLE, {
      weight: this._lineWeight
    });

    return () => {
      return emptyStyle;
    };
  }

  _makeChoroplethStyler() {
    const emptyStyle = this._makeEmptyStyleFunction();
    if (this._metrics.length === 0) {
      return {
        leafletStyleFunction: () => {
          return emptyStyle();
        },
        getLeafletBounds: () => {
          return null;
        }
      };
    }

    const { min, max } = getMinMax(this._metrics);

    const boundsOfAllFeatures = new L.LatLngBounds();
    return {
      leafletStyleFunction: (geojsonFeature) => {
        const match = geojsonFeature.__kbnJoinedMetric;
        if (!match) {
          return emptyStyle();
        }
        const boundsOfFeature = L.geoJson(geojsonFeature).getBounds();
        boundsOfAllFeatures.extend(boundsOfFeature);

        const fillColor = getChoroplethColor(match.value, min, max, this._colorRamp);
        const lineColor = (LINE_TYPE.includes(geojsonFeature.geometry.type)) ? fillColor : 'white';
        return {
          fillColor: fillColor,
          weight: this._lineWeight,
          opacity: 1,
          color: lineColor,
          fillOpacity: 0.7
        };
      },
      getLeafletBounds: function () {
        return boundsOfAllFeatures.isValid() ? boundsOfAllFeatures : null;
      }
    };
  }

}

//lexicographic compare
function compareLexicographically(termA, termB) {
  if ((termA == null) || (termB == null)) return false;
  termA = typeof termA === 'string' ? termA : termA.toString();
  termB = typeof termB === 'string' ? termB : termB.toString();
  return termA.localeCompare(termB);
}

function makeColorDarker(color) {
  const amount = 1.3;//magic number, carry over from earlier
  return d3.hcl(color).darker(amount).toString();
}


function getMinMax(data) {
  let min = data[0].value;
  let max = data[0].value;
  for (let i = 1; i < data.length; i += 1) {
    min = Math.min(data[i].value, min);
    max = Math.max(data[i].value, max);
  }
  return { min, max };
}

function getChoroplethColor(value, min, max, colorRamp) {
  if (min === max) {
    return colorUtil.getColor(colorRamp, colorRamp.length - 1);
  }
  const fraction = (value - min) / (max - min);
  const index = Math.round(colorRamp.length * fraction) - 1;
  const i = Math.max(Math.min(colorRamp.length - 1, index), 0);

  return colorUtil.getColor(colorRamp, i);
}



